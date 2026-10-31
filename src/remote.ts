// Remote access: lets lingcode.dev/remote (a browser on the owner's phone or
// another computer, or a helper with an invite link) chat with this PC's
// agent. Speaks the same relay protocol as the Mac app's RemoteCodingService:
// JSON frames over wss://…/ws/collab/<hostId>/__serve.
//
//   host  → relay: lc-serve-host-hello, then lc-agent-list-result /
//                  lc-agent-state / lc-agent-detached / lc-agent-error
//   relay → host:  lc-serve-host-ack, lc-agent-list / attach / detach / cmd
//
// Every chat in the open project is offered as a session, newest first. Only
// one runs at a time (the one on screen): opening another one shows its saved
// history, and sending to it switches the PC to that chat first. Commands go
// through ChatPanel.sendExternal, the same path as typing, so a remote message
// never races a local one.

import { api } from "./api";
import type { ChatPanel } from "./chat";
import { ChatDoc, ChatMeta, remoteMessages } from "./simple-logic";

/** What the host needs from the app's chat list (main.ts). */
export interface RemoteChats {
  project: () => string | null;
  list: () => Promise<ChatMeta[]>;
  load: (id: string) => Promise<ChatDoc | null>;
  /** Put this chat on screen, as clicking it in the sidebar does. */
  open: (id: string) => Promise<void>;
  create: () => Promise<void>;
}

/** The most chats offered; the remote list is a picker, not an archive. */
const MAX_SESSIONS = 50;
const PREFIX = "lcb-chat:";
/** The id builds before 1.5.7 used for "the chat on screen"; a browser that
 *  attached to it reconnects with it. */
const LEGACY_ID = "lingcodebaby-chat";

type Status = "off" | "connecting" | "online" | "error";

export class RemoteHost {
  status: Status = "off";
  statusText = "Off";
  onStatus: (status: Status, text: string) => void = () => {};

  private ws: WebSocket | null = null;
  private wanted = false;
  /** documentIds a browser is watching. */
  private attached = new Set<string>();
  private retry = 0;
  private retryTimer: number | undefined;
  private stateTimer: number | undefined;
  private lastListSig = "";

  constructor(private chat: ChatPanel, private chats: RemoteChats) {
    const prev = chat.onTranscriptChange;
    chat.onTranscriptChange = () => { prev(); this.changed(); };
  }

  /** The chat list changed (new, renamed, deleted, switched): refresh it. */
  chatsChanged() {
    if (this.status === "online") void this.sendList(false);
  }

  private docId(chatId: string) { return PREFIX + chatId; }

  /** The chat a documentId names; the legacy id means the one on screen. */
  private chatIdOf(docId: string): string | null {
    if (docId === LEGACY_ID) return this.chat.currentChatId();
    return docId.startsWith(PREFIX) ? docId.slice(PREFIX.length) : null;
  }

  private isOnScreen(docId: string) {
    const id = this.chatIdOf(docId);
    return !!id && id === this.chat.currentChatId();
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
    this.attached.clear();
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
      this.attached.clear();
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
        void this.sendList(true);
        break;
      case "lc-agent-attach":
        void this.attach(String(f.documentId ?? ""));
        break;
      case "lc-agent-detach":
        if (f.documentId) this.attached.delete(String(f.documentId)); else this.attached.clear();
        break;
      case "lc-agent-cmd":
        void this.command(f);
        break;
      case "lc-term-list":
        // No terminal mirror on Windows yet.
        this.send({ type: "lc-term-list-result", terminals: [] });
        break;
    }
  }

  private async attach(docId: string) {
    const id = this.chatIdOf(docId);
    const known = id === this.chat.currentChatId() || (!!id && (await this.chats.load(id)) !== null);
    if (!known) { this.send({ type: "lc-agent-detached", documentId: docId }); return; }
    this.attached.add(docId);
    await this.sendState(docId);
  }

  /** Make `docId` the chat on screen so a message can go to it. Refused while
   *  another chat is mid-reply: switching would stop that reply. */
  private async bringUp(docId: string): Promise<boolean> {
    if (this.isOnScreen(docId)) return true;
    const id = this.chatIdOf(docId);
    if (!id) return false;
    if (this.chat.isBusy()) {
      this.send({ type: "lc-agent-error", message: "The PC is still working in another chat. Wait for it to finish (or stop it there), then send again." });
      return false;
    }
    await this.chats.open(id);
    return this.isOnScreen(docId);
  }

  private async command(f: any) {
    const docId = String(f.documentId ?? "");
    switch (f.cmd) {
      case "send":
        if (await this.bringUp(docId)) this.chat.sendExternal(String(f.text ?? ""));
        break;
      case "stop":
        if (this.isOnScreen(docId)) this.chat.abort();
        break;
      case "submitUserInput": {
        if (!this.isOnScreen(docId)) break;
        // One question, one choice: send the chosen option's text as the reply.
        const answers = f.answers && typeof f.answers === "object" ? Object.values(f.answers) : [];
        const first = answers.flat()[0];
        if (first != null) this.chat.sendExternal(String(first));
        break;
      }
      case "new": {
        if (this.chat.isBusy()) {
          this.send({ type: "lc-agent-error", message: "The PC is still working in another chat. Wait for it to finish (or stop it there), then start a new one." });
          break;
        }
        await this.chats.create();
        const id = this.chat.currentChatId();
        if (!id) { this.send({ type: "lc-agent-error", message: "Open a project in LingCodeBaby on the PC first." }); break; }
        // The page adopts the session whose first state echoes its requestId.
        const newId = this.docId(id);
        this.attached.add(newId);
        this.send({ type: "lc-agent-state", documentId: newId, requestId: f.requestId, provider: "claude", snapshot: this.chat.remoteSnapshot() });
        void this.sendList(false);
        break;
      }
      default:
        // approve/deny: LingCodeBaby runs without approval prompts; setModel/cancel: not offered.
        break;
    }
  }

  /** Something in the chat changed: refresh the list (cheap, deduped) and the
   *  attached snapshot (throttled to ~6 a second, like the Mac). */
  private changed() {
    if (this.status !== "online") return;
    void this.sendList(false);
    if (!this.attached.size || this.stateTimer !== undefined) return;
    this.stateTimer = window.setTimeout(() => {
      this.stateTimer = undefined;
      for (const docId of this.attached) if (this.isOnScreen(docId)) void this.sendState(docId);
    }, 160);
  }

  private async sendList(force: boolean) {
    const current = this.chat.currentChatId();
    let metas: ChatMeta[] = [];
    try { metas = await this.chats.list(); } catch { metas = []; }
    // A chat just started on the PC isn't saved yet: offer it too.
    const ids = metas.map((m) => m.id);
    if (current && !ids.includes(current)) metas = [{ id: current, title: "New chat", createdAt: Date.now(), updatedAt: Date.now() }, ...metas];
    const project = this.chats.project();
    const sessions = metas.slice(0, MAX_SESSIONS).map((m) => {
      const live = m.id === current;
      return {
        documentId: this.docId(m.id),
        displayName: (project ? `${project} · ` : "") + (live ? this.chat.remoteSnapshot().title : m.title),
        isStreaming: live && this.chat.isBusy(),
        needsInput: live && this.chat.hasQuestion(),
        provider: "claude",
      };
    });
    const sig = JSON.stringify(sessions);
    if (!force && sig === this.lastListSig) return;
    this.lastListSig = sig;
    this.send({ type: "lc-agent-list-result", sessions });
  }

  private async sendState(docId: string) {
    if (!this.attached.has(docId)) return;
    if (this.isOnScreen(docId)) {
      this.send({ type: "lc-agent-state", documentId: docId, provider: "claude", snapshot: this.chat.remoteSnapshot() });
      return;
    }
    // Not on screen: its saved history, at rest.
    const id = this.chatIdOf(docId);
    const doc = id ? await this.chats.load(id) : null;
    if (!doc) { this.attached.delete(docId); this.send({ type: "lc-agent-detached", documentId: docId }); return; }
    this.send({ type: "lc-agent-state", documentId: docId, provider: "claude", snapshot: {
      isStreaming: false, title: doc.title || "New chat", model: doc.model ?? "", messages: remoteMessages(doc.messages),
      inFlight: null, pendingApproval: null, pendingUserInput: null,
    } });
  }

}
