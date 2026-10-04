// Remote access: lets lingcode.dev/remote (a browser on the owner's phone or
// another computer, or a helper with an invite link) chat with this PC's
// agent. Speaks the same relay protocol as the Mac app's RemoteCodingService:
// JSON frames over wss://…/ws/collab/<hostId>/__serve.
//
//   host  → relay: lc-serve-host-hello, then lc-agent-list-result /
//                  lc-agent-state / lc-agent-detached / lc-agent-error
//   relay → host:  lc-serve-host-ack, lc-agent-list / attach / detach / cmd
//
// LingCodeBaby has one chat at a time, so it offers one session: the chat on
// screen. Commands go through ChatPanel.sendExternal, the same path as typing,
// so a remote message never races a local one.

import { api } from "./api";
import type { ChatPanel } from "./chat";

type Status = "off" | "connecting" | "online" | "error";

export class RemoteHost {
  status: Status = "off";
  statusText = "Off";
  onStatus: (status: Status, text: string) => void = () => {};

  private ws: WebSocket | null = null;
  private wanted = false;
  private attached = false;
  private retry = 0;
  private retryTimer: number | undefined;
  private stateTimer: number | undefined;
  private lastListSig = "";

  /** One session, always this id: switching chats on the PC changes what it
   *  shows rather than ending it, so the browser never has to re-attach. */
  private readonly sessionId = () => "lingcodebaby-chat";

  constructor(private chat: ChatPanel, private title: () => string) {
    const prev = chat.onTranscriptChange;
    chat.onTranscriptChange = () => { prev(); this.changed(); };
  }

  async start() {
    this.wanted = true;
    await this.connect();
  }

  stop() {
    this.wanted = false;
    window.clearTimeout(this.retryTimer);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch { /* closed */ } }
    this.ws = null;
    this.attached = false;
    this.set("off", "Off");
  }

  private set(status: Status, text: string) {
    this.status = status;
    this.statusText = text;
    this.onStatus(status, text);
  }

  private async connect() {
    if (!this.wanted) return;
    this.set("connecting", "Connecting…");
    let reg;
    try {
      reg = await api.remoteRegister();
    } catch (e) {
      this.set("error", String(e));
      this.scheduleRetry();
      return;
    }
    if (!this.wanted) return;
    const ws = new WebSocket(reg.wsUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => this.send({ type: "lc-serve-host-hello" });
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onclose = () => {
      this.ws = null;
      this.attached = false;
      if (this.wanted) { this.set("connecting", "Reconnecting…"); this.scheduleRetry(); }
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleRetry() {
    window.clearTimeout(this.retryTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retry++, 5));
    this.retryTimer = window.setTimeout(() => { void this.connect(); }, delay);
  }

  private send(frame: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private onFrame(data: unknown) {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    // The relay also carries binary Yjs frames; only JSON starting with "{" is ours.
    if (!text.startsWith("{")) return;
    let f: any;
    try { f = JSON.parse(text); } catch { return; }
    switch (f.type) {
      case "lc-serve-host-ack":
        this.retry = 0;
        this.set("online", "On — this PC shows up at lingcode.dev/remote");
        break;
      case "lc-agent-list":
        this.sendList(true);
        break;
      case "lc-agent-attach":
        if (f.documentId === this.sessionId()) { this.attached = true; this.sendState(); }
        else this.send({ type: "lc-agent-detached", documentId: f.documentId });
        break;
      case "lc-agent-detach":
        this.attached = false;
        break;
      case "lc-agent-cmd":
        this.command(f);
        break;
      case "lc-term-list":
        // No terminal mirror on Windows yet.
        this.send({ type: "lc-term-list-result", terminals: [] });
        break;
    }
  }

  private command(f: any) {
    switch (f.cmd) {
      case "send":
        this.chat.sendExternal(String(f.text ?? ""));
        break;
      case "stop":
        this.chat.abort();
        break;
      case "submitUserInput": {
        // One question, one choice: send the chosen option's text as the reply.
        const answers = f.answers && typeof f.answers === "object" ? Object.values(f.answers) : [];
        const first = answers.flat()[0];
        if (first != null) this.chat.sendExternal(String(first));
        break;
      }
      case "new":
        this.send({ type: "lc-agent-error", message: "Start a new chat in LingCodeBaby on the PC; the open chat is shown here." });
        break;
      default:
        // approve/deny: LingCodeBaby runs without approval prompts; setModel/cancel: not offered.
        break;
    }
  }

  /** Something in the chat changed: refresh the list (cheap, deduped) and the
   *  attached snapshot (throttled to ~6 a second, like the Mac). */
  private changed() {
    if (this.status !== "online") return;
    this.sendList(false);
    if (!this.attached || this.stateTimer !== undefined) return;
    this.stateTimer = window.setTimeout(() => { this.stateTimer = undefined; this.sendState(); }, 160);
  }

  private sendList(force: boolean) {
    const session = {
      documentId: this.sessionId(),
      displayName: this.title(),
      isStreaming: this.chat.isBusy(),
      needsInput: this.chat.hasQuestion(),
      provider: "claude",
    };
    const sig = JSON.stringify(session);
    if (!force && sig === this.lastListSig) return;
    this.lastListSig = sig;
    this.send({ type: "lc-agent-list-result", sessions: [session] });
  }

  private sendState() {
    if (!this.attached) return;
    this.send({ type: "lc-agent-state", documentId: this.sessionId(), provider: "claude", snapshot: this.chat.remoteSnapshot() });
  }

}
