import { claudeSend, ChatEvent, api } from "./api";
import { VoiceSession, type VoicePhase } from "./voice";

interface Entry { el: HTMLElement; clean: boolean; }

export class ChatPanel {
  getCwd: () => string | null = () => null;
  onFilesModified: () => void = () => {};
  getModel: () => string = () => "lingmodel";
  // Gate a send on required auth (e.g. LingModel needs a LingCode sign-in).
  // Return false to abort the send. Set from main.ts.
  ensureAuth: (model: string) => Promise<boolean> = async () => true;
  playSounds = true;
  private showThinking = false;
  private session: string | null = null;
  private busy = false;
  private interrupted = false;

  private transcript: HTMLElement;
  private optionsEl: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private dots: HTMLElement;
  private dotsTimer: number | null = null;
  private thinkingLine: HTMLElement | null = null;
  private thinkStart = 0;
  private entries: Entry[] = [];
  private lastAssistantText = "";

  // ── Hands-free voice mode ────────────────────────────────────────────────
  // Hidden entirely unless the account has voice available, so the composer is
  // unchanged for everyone else. Push-to-talk rather than always-listening: an
  // open mic in a shared room is a privacy problem, and it removes any need for
  // wake-word detection.
  private micBtn: HTMLButtonElement;
  private voiceBar: HTMLElement;
  private voice: VoiceSession | null = null;
  private voiceReady = false;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="transcript"></div>
      <div class="options"></div>
      <div class="voice-bar" hidden></div>
      <div class="chat-input-row">
        <textarea class="chat-input" placeholder="Ask Claude…" rows="1"></textarea>
        <button class="mic-btn" title="Hold to talk" hidden>🎤</button>
        <button class="send-btn">Send</button>
      </div>`;
    this.transcript = root.querySelector(".transcript") as HTMLElement;
    this.optionsEl = root.querySelector(".options") as HTMLElement;
    this.input = root.querySelector(".chat-input") as HTMLTextAreaElement;
    this.sendBtn = root.querySelector(".send-btn") as HTMLButtonElement;
    this.micBtn = root.querySelector(".mic-btn") as HTMLButtonElement;
    this.voiceBar = root.querySelector(".voice-bar") as HTMLElement;
    this.wireVoice();
    this.dots = document.createElement("span");
    this.dots.className = "dots";

    this.sendBtn.onclick = () => this.send();
    this.input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
    };
    this.input.oninput = () => {
      this.input.style.height = "auto";
      this.input.style.height = Math.min(this.input.scrollHeight, 140) + "px";
    };
  }

  /** Reveal the mic only if the account can actually use voice. */
  private wireVoice() {
    void (async () => {
      try {
        const st = await api.voiceStatus();
        this.voiceReady = st.signed_in && st.transcribe && st.speak;
        this.micBtn.hidden = !this.voiceReady;
        if (!this.voiceReady && st.reason) this.micBtn.title = st.reason;
      } catch {
        this.micBtn.hidden = true;   // voice unavailable — composer unchanged
      }
    })();

    // Push-to-talk: hold the button (or Ctrl/Cmd+Shift+Space) to speak.
    // pointerup is bound on the window so releasing off the button still stops
    // the recording instead of leaving the mic open.
    const down = (e: Event) => { e.preventDefault(); void this.startVoice(); };
    const up = () => this.voice?.endListening();
    this.micBtn.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", (e) => {
      if (!this.voiceReady) return;
      if (e.code === "Space" && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.repeat) {
        e.preventDefault(); void this.startVoice();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space" || e.key === "Shift") up();
    });
  }

  /** Lazily create the session on first use so we don't hold the mic open (and
   *  keep the OS recording indicator lit) for people who never use voice. */
  private async startVoice() {
    if (!this.voiceReady) return;
    if (!this.voice) {
      const cwd = this.getCwd();
      if (!cwd) { this.setVoiceBar("Open a folder first."); return; }
      const s = new VoiceSession();
      s.onPhase = (p, detail) => this.renderVoicePhase(p, detail);
      s.onTranscript = (t) => this.postNote(`🎤 ${t}`);
      s.onAgentEvent = (e) => this.handleEvent(e);
      try {
        await s.start(cwd, this.getModel());
      } catch (err) {
        this.setVoiceBar(String(err));
        return;
      }
      this.voice = s;
    }
    this.voice.beginListening();
  }

  /** Stop voice mode and release the microphone. */
  async stopVoice() {
    await this.voice?.stop();
    this.voice = null;
    this.setVoiceBar("");
  }

  private renderVoicePhase(p: VoicePhase, detail?: string) {
    const label: Record<VoicePhase, string> = {
      off: "",
      idle: "Hold the mic and speak",
      listening: "Listening…",
      thinking: "Working out what you said…",
      confirming: "Say “go” to run it, or “cancel”",
      running: "Running…",
      approving: "Say “confirm run” to allow, or “deny”",
      speaking: "Speaking…",
    };
    this.micBtn.classList.toggle("recording", p === "listening");
    this.setVoiceBar(detail && (p === "confirming" || p === "approving")
      ? `${label[p]} — ${detail}`
      : label[p]);
  }

  private setVoiceBar(text: string) {
    this.voiceBar.textContent = text;
    this.voiceBar.hidden = !text;
  }

  postNote(text: string) {
    this.append(escapeHtml(text), "note", true);
  }

  setShowThinking(on: boolean) {
    this.showThinking = on;
    for (const e of this.entries) e.el.style.display = (on || e.clean) ? "" : "none";
  }

  isBusy() { return this.busy; }

  private append(html: string, cls: string, clean: boolean) {
    const el = document.createElement("div");
    el.className = "msg " + cls;
    el.innerHTML = html;
    el.style.display = (this.showThinking || clean) ? "" : "none";
    this.transcript.appendChild(el);
    this.entries.push({ el, clean });
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  private appendRole(role: string, text: string) {
    this.append(`<span class="role">${role}</span>${escapeHtml(text)}`, "", true);
  }

  private async send(prefill?: string) {
    const message = prefill ?? this.input.value.trim();
    if (!message || this.busy) return;
    const cwd = this.getCwd();
    if (!cwd) { this.append("Open a folder first to chat with Claude about your project.", "note", true); return; }

    // Gate before echoing the message — e.g. LingModel requires a LingCode
    // sign-in; this may open the sign-in flow. Abort silently if it fails/cancels.
    if (!(await this.ensureAuth(this.getModel()))) return;

    this.clearOptions();
    this.appendRole("You", message);
    this.input.value = "";
    this.input.style.height = "auto";
    this.setBusy(true);
    this.interrupted = false;
    this.lastAssistantText = "";
    this.startThinkingLine();

    try {
      await claudeSend(
        { message, cwd, model: this.getModel(), resume: this.session },
        (e) => this.handleEvent(e)
      );
    } catch (err) {
      this.append("Claude error: " + escapeHtml(String(err)), "note", true);
    } finally {
      this.stopThinkingLine();
      this.setBusy(false);
    }
  }

  private handleEvent(e: ChatEvent) {
    switch (e.kind) {
      case "session": this.session = e.id; break;
      case "thinking":
        this.append(`🧠 ${escapeHtml(e.text)}`, "thinking", false);
        break;
      case "text":
        this.lastAssistantText = e.text;
        this.append(escapeHtml(e.text), "thinking", false);
        break;
      case "tool":
        this.append(`🔧 ${escapeHtml(e.name)} ${escapeHtml(e.detail)}`, "tool", false);
        break;
      case "edit":
        this.append(this.renderEdit(e.name, e.input), "edit", true);
        break;
      case "ask_user":
        this.stopThinkingLine();
        this.showOptions(e.question, e.options);
        if (this.playSounds) beep(880);
        break;
      case "result":
        if (e.is_error) {
          this.append("Claude error: " + escapeHtml(e.text), "note", true);
        } else if (e.text && e.text.trim() && e.text.trim() !== this.lastAssistantText.trim()) {
          this.append(`<span class="role">Claude</span>${escapeHtml(e.text)}`, "", true);
        } else if (this.lastAssistantText.trim()) {
          // Promote the streamed text to a final answer.
          this.append(`<span class="role">Claude</span>${escapeHtml(this.lastAssistantText)}`, "", true);
        }
        this.onFilesModified();
        break;
      case "awaiting":
        this.interrupted = true;
        break;
      case "done":
        if (!this.interrupted && this.playSounds) beep(660);
        if (e.stderr && this.transcript.childElementCount === 0) {
          this.append("Claude exited without output. " + escapeHtml(e.stderr), "note", true);
        }
        this.onFilesModified();
        break;
    }
  }

  private renderEdit(name: string, input: any): string {
    const file = input?.file_path || input?.path || "";
    let lines: string[] = [`<span class="file">✏️ ${escapeHtml(name)} ${escapeHtml(file)}</span>`];
    const pushDiff = (oldS: string, newS: string) => {
      for (const l of String(oldS ?? "").split("\n")) lines.push(`<span class="del">- ${escapeHtml(l)}</span>`);
      for (const l of String(newS ?? "").split("\n")) lines.push(`<span class="add">+ ${escapeHtml(l)}</span>`);
    };
    if (name === "Write") {
      for (const l of String(input?.content ?? "").split("\n")) lines.push(`<span class="add">+ ${escapeHtml(l)}</span>`);
    } else if (name === "MultiEdit" && Array.isArray(input?.edits)) {
      for (const ed of input.edits) pushDiff(ed.old_string, ed.new_string);
    } else {
      pushDiff(input?.old_string, input?.new_string);
    }
    if (lines.length > 81) { lines = lines.slice(0, 81); lines.push("…"); }
    return lines.join("\n");
  }

  private showOptions(question: string, options: string[]) {
    this.append(`<span class="role">Claude</span>${escapeHtml(question)}`, "", true);
    this.clearOptions();
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.className = "opt";
      btn.textContent = opt;
      btn.onclick = () => { this.clearOptions(); this.send(opt); };
      this.optionsEl.appendChild(btn);
    }
  }

  private clearOptions() { this.optionsEl.innerHTML = ""; }

  private setBusy(b: boolean) {
    this.busy = b;
    this.sendBtn.disabled = b;
    this.sendBtn.textContent = b ? "…" : "Send";
  }

  abort() {
    if (!this.busy) return;
    api.claudeAbort();
    this.append("Stopped.", "note", true);
  }

  private startThinkingLine() {
    this.thinkStart = Date.now();
    this.thinkingLine = document.createElement("div");
    this.thinkingLine.className = "thinking-line";
    this.transcript.appendChild(this.thinkingLine);
    const tick = () => {
      if (!this.thinkingLine) return;
      const s = Math.floor((Date.now() - this.thinkStart) / 1000);
      this.thinkingLine.textContent = `Claude is thinking… (${s}s)`;
      this.transcript.scrollTop = this.transcript.scrollHeight;
    };
    tick();
    this.dotsTimer = window.setInterval(tick, 400);
  }

  private stopThinkingLine() {
    if (this.dotsTimer) { clearInterval(this.dotsTimer); this.dotsTimer = null; }
    this.thinkingLine?.remove();
    this.thinkingLine = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

let audioCtx: AudioContext | null = null;
function beep(freq: number) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.06, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch { /* ignore */ }
}
