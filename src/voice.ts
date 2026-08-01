// voice.ts — the hands-free turn loop.
//
//   push-to-talk → transcribe → shape → read intent back → "go" → agent runs
//   → risky tools spoken for confirmation → spoken summary → "what next?"
//
// Capture and playback live here because only the webview has getUserMedia and
// an <audio> element. Everything that touches the network goes through Rust: the
// Tauri CSP pins `connect-src` to 'self' and ipc:, and widening it would let any
// injected script reach the internet.
//
// Two things in here are deliberate and worth not "simplifying":
//
//   1. The mic is muted while we speak. Without half-duplex the agent's own
//      voice is transcribed as the next instruction, which produces a feedback
//      loop that looks like the app talking to itself.
//   2. Confirmation needs a distinct phrase ("confirm run"), never a bare "yes".
//      Speech-to-text confuses yes/yep/yeah/next/nope constantly, and this is
//      the one place a misrecognition is expensive.

import { listen } from "@tauri-apps/api/event";
import { api, claudeSend } from "./api";
import type { ChatEvent, VoiceStatus, VoiceShaped } from "./api";

interface ApprovalRequest { id: string; tool_name: string; summary: string }

/** What the loop is doing, so the UI can show it and we can reject bad input. */
export type VoicePhase =
  | "off"
  | "idle"          // armed, waiting for push-to-talk
  | "listening"
  | "thinking"      // transcribing / shaping
  | "confirming"    // read the intent back, waiting for "go"
  | "running"       // the agent has the turn
  | "approving"     // a risky tool is waiting on a spoken confirmation
  | "speaking";

/** Phrases that mean "go ahead" for a shaped prompt. */
const GO_PHRASES = ["go", "go ahead", "do it", "yes go", "run it", "send it", "confirm"];
/** Phrases that abandon the shaped prompt. */
const CANCEL_PHRASES = ["cancel", "stop", "never mind", "nevermind", "forget it", "scratch that"];
/**
 * Phrases that approve a RISKY tool. Deliberately two words and deliberately
 * NOT "yes" — see the header note.
 */
const APPROVE_PHRASES = ["confirm run", "confirm yes", "approved", "i confirm", "confirm it"];
const DENY_PHRASES = ["deny", "don't", "do not", "skip it", "no don't", "refuse"];

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Does the utterance match one of `phrases`? Exported for tests. */
export function matchesPhrase(heard: string, phrases: string[]): boolean {
  const n = normalise(heard);
  if (!n) return false;
  return phrases.some(p => n === p || n.startsWith(p + " ") || n.endsWith(" " + p));
}

export class VoiceSession {
  phase: VoicePhase = "off";
  onPhase: (p: VoicePhase, detail?: string) => void = () => {};
  onTranscript: (text: string) => void = () => {};
  onAgentEvent: (e: ChatEvent) => void = () => {};

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mime = "";
  private audio: HTMLAudioElement | null = null;
  /** The shaped prompt awaiting a spoken "go". */
  private staged: VoiceShaped | null = null;
  /** The risky tool awaiting a spoken confirmation. */
  private pendingApproval: ApprovalRequest | null = null;
  private unlistenApproval: (() => void) | null = null;
  private cwd = "";
  private model = "";
  private resume: string | null = null;

  async status(): Promise<VoiceStatus> {
    return api.voiceStatus();
  }

  /** Arm the session. Requests mic permission up front so the first push-to-talk
   *  isn't swallowed by a permission dialog. */
  async start(cwd: string, model: string): Promise<void> {
    this.cwd = cwd;
    this.model = model;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This system has no microphone support available.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mime = pickMime();
    if (!this.mime) throw new Error("This system can't record audio in a supported format.");

    // Risky-tool requests arrive from Rust while a turn is running.
    this.unlistenApproval = await listen<ApprovalRequest>("voice://approval-request", (ev) => {
      void this.handleApprovalRequest(ev.payload);
    });
    this.setPhase("idle");
  }

  async stop(): Promise<void> {
    this.stopRecording();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.unlistenApproval?.();
    this.unlistenApproval = null;
    this.staged = null;
    // Never leave a risky tool hanging on a session we're tearing down.
    if (this.pendingApproval) {
      await api.voiceApproveResolve(this.pendingApproval.id, false);
      this.pendingApproval = null;
    }
    this.setPhase("off");
  }

  /** Begin capturing. Ignored unless we're in a phase that accepts speech. */
  beginListening(): void {
    if (!this.stream) return;
    if (!["idle", "confirming", "approving"].includes(this.phase)) return;
    if (this.recorder) return;
    // Half-duplex: stop talking the moment the user starts.
    this.stopSpeaking();
    this.chunks = [];
    try {
      this.recorder = new MediaRecorder(this.stream, { mimeType: this.mime });
    } catch {
      this.setPhase(this.phase, "Couldn't start recording.");
      return;
    }
    this.recorder.ondataavailable = e => { if (e.data?.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => { void this.onRecordingStopped(); };
    this.recorder.start(250);
    this.setPhase("listening");
  }

  /** Release push-to-talk. */
  endListening(): void {
    this.stopRecording();
  }

  private stopRecording(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      try { this.recorder.stop(); } catch { /* already stopped */ }
    }
    this.recorder = null;
  }

  private async onRecordingStopped(): Promise<void> {
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
    if (blob.size === 0) {
      await this.say("I didn't hear anything.");
      return;
    }
    const priorPhase = this.phase;
    this.setPhase("thinking");
    let heard: string;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      heard = await api.voiceTranscribe(Array.from(bytes), this.mime);
    } catch (e) {
      await this.say(String(e));
      this.setPhase(priorPhase === "listening" ? "idle" : priorPhase);
      return;
    }
    this.onTranscript(heard);

    // Route the utterance by what we were doing before the user spoke.
    if (this.pendingApproval) return void this.resolveApprovalFromSpeech(heard);
    if (this.staged) return void this.resolveStagedFromSpeech(heard);
    return void this.shapeAndConfirm(heard);
  }

  // ── Shape → read back → wait for "go" ────────────────────────────────────

  private async shapeAndConfirm(heard: string): Promise<void> {
    let shaped: VoiceShaped;
    try {
      shaped = await api.voiceShape(heard);
    } catch (e) {
      await this.say(String(e));
      this.setPhase("idle");
      return;
    }
    this.staged = shaped;
    this.setPhase("confirming", shaped.prompt);
    await this.say(`${shaped.summary}. Say go to run it, or cancel.`);
    // say() returns to the phase it was called in, so we stay in "confirming".
  }

  private async resolveStagedFromSpeech(heard: string): Promise<void> {
    const staged = this.staged;
    if (!staged) return;
    if (matchesPhrase(heard, CANCEL_PHRASES)) {
      this.staged = null;
      this.setPhase("idle");
      await this.say("Cancelled. What next?");
      return;
    }
    if (matchesPhrase(heard, GO_PHRASES)) {
      this.staged = null;
      await this.runTurn(staged.prompt);
      return;
    }
    // Anything else is treated as a REPLACEMENT instruction rather than a
    // command — that's how people actually talk when they misspoke.
    await this.shapeAndConfirm(heard);
  }

  // ── The agent turn ───────────────────────────────────────────────────────

  private async runTurn(prompt: string): Promise<void> {
    this.setPhase("running", prompt);
    let lastText = "";
    let sawError = false;
    try {
      await claudeSend(
        {
          message: prompt,
          cwd: this.cwd,
          model: this.model,
          resume: this.resume,
          voiceMode: true,        // switches Rust to the spoken approval gate
        },
        (e: ChatEvent) => {
          this.onAgentEvent(e);
          if (e.kind === "session") this.resume = e.id;
          if (e.kind === "text" && e.text.trim()) lastText = e.text.trim();
          if (e.kind === "result") { lastText = e.text.trim() || lastText; sawError = e.is_error; }
        },
      );
    } catch (e) {
      await this.say(`That didn't run. ${String(e)}`);
      this.setPhase("idle");
      return;
    }
    this.setPhase("idle");
    const summary = speakableSummary(lastText);
    await this.say(sawError
      ? `That finished with an error. ${summary}`
      : `${summary} What next?`);
  }

  // ── Risky-tool approval ──────────────────────────────────────────────────

  private async handleApprovalRequest(req: ApprovalRequest): Promise<void> {
    this.pendingApproval = req;
    this.setPhase("approving", req.summary);
    await this.say(`I need to ${req.summary}. Say confirm run to allow it, or deny.`);
  }

  private async resolveApprovalFromSpeech(heard: string): Promise<void> {
    const req = this.pendingApproval;
    if (!req) return;
    const approve = matchesPhrase(heard, APPROVE_PHRASES);
    const deny = matchesPhrase(heard, DENY_PHRASES);
    if (!approve && !deny) {
      // Do NOT guess. Re-ask; the timeout in Rust will deny if we never resolve.
      await this.say("I didn't get a clear answer. Say confirm run, or deny.");
      return;
    }
    this.pendingApproval = null;
    await api.voiceApproveResolve(req.id, approve);
    this.setPhase("running");
    await this.say(approve ? "Confirmed." : "Skipped.");
  }

  // ── Speech output ────────────────────────────────────────────────────────

  /** Speak `text`, muting the mic for the duration so we don't transcribe
   *  ourselves. Resolves when playback finishes (or immediately on failure —
   *  a silent step is better than a stuck loop). */
  private async say(text: string): Promise<void> {
    if (!text.trim()) return;
    const resumePhase = this.phase;
    this.setPhase("speaking", text);
    this.setMicEnabled(false);
    try {
      const [bytes, contentType] = await api.voiceSpeak(text);
      const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
      const url = URL.createObjectURL(blob);
      this.audio = new Audio(url);
      await new Promise<void>((resolve) => {
        if (!this.audio) return resolve();
        this.audio.onended = () => resolve();
        this.audio.onerror = () => resolve();
        this.audio.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } catch {
      // Voice output unavailable — the transcript still shows everything.
    } finally {
      this.audio = null;
      this.setMicEnabled(true);
      this.setPhase(resumePhase);
    }
  }

  private stopSpeaking(): void {
    if (this.audio) {
      try { this.audio.pause(); } catch { /* nothing playing */ }
      this.audio = null;
    }
  }

  private setMicEnabled(on: boolean): void {
    this.stream?.getAudioTracks().forEach(t => { t.enabled = on; });
  }

  private setPhase(p: VoicePhase, detail?: string): void {
    this.phase = p;
    this.onPhase(p, detail);
  }
}

/** First supported MediaRecorder container. WebView2 lands on webm/opus. */
export function pickMime(): string {
  const candidates = [
    "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus",
    "audio/mp4", "audio/mpeg", "audio/wav",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  return candidates.find(t => {
    try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
  }) ?? "";
}

/**
 * Condense an agent reply into something worth listening to. Code blocks and
 * long paths are unlistenable read aloud, so they're dropped rather than spoken.
 * Exported for tests.
 */
export function speakableSummary(text: string, maxChars = 320): string {
  if (!text?.trim()) return "Done.";
  let t = text
    .replace(/```[\s\S]*?```/g, " ")     // fenced code
    .replace(/`([^`]*)`/g, "$1")         // inline code ticks
    .replace(/^#{1,6}\s*/gm, "")         // md headings
    .replace(/\*\*|__|\*|_/g, "")        // md emphasis
    .replace(/^\s*[-*+]\s+/gm, "")       // list bullets
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "Done.";
  if (t.length <= maxChars) return t;
  // Cut on a sentence boundary when there is one reasonably close.
  const cut = t.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + "…";
}
