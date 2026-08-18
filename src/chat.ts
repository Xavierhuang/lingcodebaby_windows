import { claudeSend, ChatEvent, api, StoredHistory, StoredMessage } from "./api";
import { openUrl } from "@tauri-apps/plugin-opener";
import { alertDialog } from "./ui";

/** Row kinds that survive a save/restore round-trip. Mirrors LCBBubbleKind. */
type Kind = "user" | "assistant" | "note" | "thinking" | "tool" | "edit";

interface Entry {
  el: HTMLElement;
  clean: boolean;   // shown even with "Show Claude Thinking" off
  kind: Kind;
  text: string;     // plain text, so the row can be re-rendered on restore
}

const GREETING_NO_FOLDER =
  "Open a folder, then ask me to read or change files in it. I run on your " +
  "LingCode account (LingModel) by default — no separate Claude subscription needed.";
const GREETING_FOLDER = "Ask me to read or change files in the current folder.";
const GREETING_CLEARED = "New conversation. Ask me to read or change files in the current folder.";

export class ChatPanel {
  getCwd: () => string | null = () => null;
  onFilesModified: () => void = () => {};
  /** The agent wrote a file — open it in the editor. Mirrors the Mac
   *  ClaudeChatDelegate claudeChat:didWriteFileAtPath: hook. */
  onFileWritten: (path: string) => void = () => {};
  /** Claude asked a multiple-choice question. The Mac app badges the dock so a
   *  backgrounded window still nudges the user; main.ts does the Windows
   *  equivalent (taskbar attention). */
  onAskUser: () => void = () => {};
  getModel: () => string = () => "lingmodel";
  // Gate a send on required auth (e.g. LingModel needs a LingCode sign-in).
  // Return false to abort the send. Set from main.ts.
  ensureAuth: (model: string) => Promise<boolean> = async () => true;
  playSounds = true;
  private showThinking = false;
  private session: string | null = null;
  private busy = false;
  private interrupted = false;
  private root: string | null = null;

  private transcript: HTMLElement;
  private optionsEl: HTMLElement;
  private attachEl: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private dotsTimer: number | null = null;
  private thinkingLine: HTMLElement | null = null;
  private thinkStart = 0;
  private entries: Entry[] = [];
  private lastAssistantText = "";
  private lastWrittenPath: string | null = null;
  /** Images/documents saved under <project>/.lingcode/attachments, queued for
   *  the next send. The agent reads them by path with its Read tool. */
  private pendingAttachments: string[] = [];
  /** Prompts typed while a turn was in flight. Drained one at a time as the
   *  panel goes busy → idle. Mirrors ClaudeChat's pendingPromptQueue. */
  private pendingPrompts: Array<{ text: string; attachments: string[] }> = [];

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="transcript"></div>
      <div class="options"></div>
      <div class="attachments"></div>
      <div class="chat-input-row">
        <textarea class="chat-input" placeholder="Ask Claude…" rows="1"></textarea>
        <button class="send-btn">Send</button>
      </div>`;
    this.transcript = root.querySelector(".transcript") as HTMLElement;
    this.optionsEl = root.querySelector(".options") as HTMLElement;
    this.attachEl = root.querySelector(".attachments") as HTMLElement;
    this.input = root.querySelector(".chat-input") as HTMLTextAreaElement;
    this.sendBtn = root.querySelector(".send-btn") as HTMLButtonElement;

    this.sendBtn.onclick = () => this.send();
    this.input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
      // Escape clears a pending attachment first (Mac escapeHandler), and only
      // falls through to the field's own handling when there's nothing queued.
      if (e.key === "Escape" && this.pendingAttachments.length) {
        e.preventDefault();
        this.clearAttachments();
      }
    };
    this.input.oninput = () => {
      this.input.style.height = "auto";
      this.input.style.height = Math.min(this.input.scrollHeight, 140) + "px";
    };
    // Paste a screenshot straight into the composer (Mac imagePasteHandler).
    this.input.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) { e.preventDefault(); this.attachFile(file); }
        }
      }
    });
    // Drag & drop onto the chat pane.
    root.addEventListener("dragover", (e) => { e.preventDefault(); root.classList.add("drop-target"); });
    root.addEventListener("dragleave", () => root.classList.remove("drop-target"));
    root.addEventListener("drop", (e) => {
      e.preventDefault();
      root.classList.remove("drop-target");
      for (const file of Array.from(e.dataTransfer?.files ?? [])) this.attachFile(file);
    });

    this.append(GREETING_NO_FOLDER, "assistant", true, "Claude");
  }

  // ---- project root / persistence -----------------------------------------

  /** Point the panel at a project folder: restore that folder's saved
   *  conversation (transcript + CLI session for `--resume`), or start fresh
   *  with the folder greeting. Mirrors ClaudeChat.setRootURL:. */
  async setRoot(folder: string | null) {
    if (this.busy) this.abort();
    this.root = folder;
    this.session = null;
    this.pendingAttachments = [];
    this.pendingPrompts = [];
    this.refreshAttachmentBar();
    this.clearOptions();
    if (!folder) return;

    let doc: StoredHistory | null = null;
    try { doc = await api.historyLoad(folder); } catch { /* start fresh */ }

    this.transcript.innerHTML = "";
    this.entries = [];
    if (doc && Array.isArray(doc.messages) && doc.messages.length) {
      // A legacy adoption carries the rows but not the session id, so the two
      // apps don't `claude --resume` the same CLI session.
      this.session = doc.adopted_legacy ? null : (doc.session ?? null);
      for (const m of doc.messages) this.restoreRow(m);
      this.transcript.scrollTop = this.transcript.scrollHeight;
      return;
    }
    this.append(GREETING_FOLDER, "assistant", true, "Claude");
  }

  /** Clear the chat, the saved history for this folder, and the CLI session so
   *  the agent forgets the prior context too. Mirrors clearConversation. */
  async clearConversation() {
    this.abort();
    this.transcript.innerHTML = "";
    this.entries = [];
    this.session = null;
    this.clearOptions();
    this.pendingPrompts = [];
    await this.clearAttachments();
    if (this.root) {
      try { await api.historyClear(this.root); } catch { /* best-effort */ }
    }
    this.append(GREETING_CLEARED, "assistant", true, "Claude");
  }

  private async saveHistory() {
    if (!this.root || !this.entries.length) return;
    const messages: StoredMessage[] = this.entries.map((e) => ({
      kind: e.kind, text: e.text, clean: e.clean,
    }));
    try {
      await api.historySave(this.root, {
        session: this.session,
        model: this.getModel(),
        messages,
      });
    } catch { /* a failed save must never break the chat */ }
  }

  private restoreRow(m: StoredMessage) {
    const kind = (m.kind || "note") as Kind;
    const role = kind === "user" ? "You" : kind === "assistant" ? "Claude" : undefined;
    this.append(m.text ?? "", kind, m.clean !== false, role);
  }

  // ---- transcript ---------------------------------------------------------

  postNote(text: string) {
    this.append(text, "note", true);
  }

  setShowThinking(on: boolean) {
    this.showThinking = on;
    for (const e of this.entries) e.el.style.display = (on || e.clean) ? "" : "none";
  }

  isBusy() { return this.busy; }

  /** Render one row. `text` is kept verbatim so the row survives a save/restore
   *  round-trip; the HTML is derived from it per kind. */
  private append(text: string, kind: Kind, clean: boolean, role?: string) {
    const el = document.createElement("div");
    el.className = "msg " + (kind === "user" || kind === "assistant" ? "" : kind);
    if (role) {
      const r = document.createElement("span");
      r.className = "role";
      r.textContent = role;
      el.appendChild(r);
    }
    if (kind === "edit") {
      el.appendChild(renderDiff(text));
    } else if (kind === "assistant") {
      el.appendChild(linkify(text));
    } else {
      el.appendChild(document.createTextNode(text));
    }
    el.style.display = (this.showThinking || clean) ? "" : "none";
    this.transcript.appendChild(el);
    this.entries.push({ el, clean, kind, text });
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  // ---- attachments --------------------------------------------------------

  /** Save a pasted/dropped file under <project>/.lingcode/attachments and queue
   *  it for the next send. Mirrors attachImagePNG: / attachDocumentAtURL:. */
  private async attachFile(file: File) {
    if (!this.root) {
      this.postNote("Open a folder first, then paste or drop a file.");
      return;
    }
    const name = file.name.toLowerCase();
    if (!file.type.startsWith("image/") && (name.endsWith(".docx") || name.endsWith(".pdf"))) {
      // The Mac app extracts text with textutil / PDFKit, neither of which
      // exists on Windows. Say so rather than attaching an unreadable blob.
      this.postNote(
        `Can't extract text from ${file.name} on Windows yet — save it as .txt or .md and drop that instead.`,
      );
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const ext = name.includes(".") ? name.split(".").pop()! : "png";
      const path = await api.attachSave(this.root, toBase64(buf), ext);
      this.pendingAttachments.push(path);
      this.refreshAttachmentBar();
      this.postNote("📎 Attached — it'll go with your next message.");
    } catch (e) {
      this.postNote("Couldn't save the attachment: " + String(e));
    }
  }

  private async clearAttachments() {
    const paths = this.pendingAttachments;
    this.pendingAttachments = [];
    this.refreshAttachmentBar();
    for (const p of paths) {
      try { await api.attachRemove(p); } catch { /* best-effort */ }
    }
  }

  private refreshAttachmentBar() {
    this.attachEl.innerHTML = "";
    // Queued prompts first — one chip each with its own ✕, so a single mistake
    // can be dropped without clearing the whole queue.
    this.pendingPrompts.forEach((entry, i) => {
      const preview = entry.text.length > 22 ? entry.text.slice(0, 22) + "…" : entry.text;
      const label = preview || `📎 ${entry.attachments.length} file(s)`;
      const chip = document.createElement("button");
      chip.className = "attach-chip queued";
      chip.textContent = `⏳ ${label}${entry.attachments.length && preview ? ` 📎${entry.attachments.length}` : ""}  ✕`;
      chip.title = "Remove this queued prompt";
      chip.onclick = async () => {
        this.pendingPrompts.splice(i, 1);
        this.refreshAttachmentBar();
        for (const p of entry.attachments) {
          try { await api.attachRemove(p); } catch { /* best-effort */ }
        }
      };
      this.attachEl.appendChild(chip);
    });
    // "Clear all" only earns its space once the queue is long enough.
    if (this.pendingPrompts.length >= 3) {
      const clearAll = document.createElement("button");
      clearAll.className = "attach-chip queued";
      clearAll.textContent = "Clear all  ✕";
      clearAll.title = "Drop every queued prompt";
      clearAll.onclick = async () => {
        const dropped = this.pendingPrompts;
        this.pendingPrompts = [];
        this.refreshAttachmentBar();
        for (const e of dropped) {
          for (const p of e.attachments) {
            try { await api.attachRemove(p); } catch { /* best-effort */ }
          }
        }
      };
      this.attachEl.appendChild(clearAll);
    }
    this.pendingAttachments.forEach((path, i) => {
      const chip = document.createElement("button");
      chip.className = "attach-chip";
      chip.textContent = `📎 ${i + 1}  ✕`;
      chip.title = `Remove ${path}`;
      chip.onclick = async () => {
        this.pendingAttachments = this.pendingAttachments.filter((p) => p !== path);
        this.refreshAttachmentBar();
        try { await api.attachRemove(path); } catch { /* best-effort */ }
      };
      this.attachEl.appendChild(chip);
    });
  }

  // ---- turn ---------------------------------------------------------------

  private async send(prefill?: string) {
    const message = prefill ?? this.input.value.trim();
    const attachments = this.pendingAttachments;
    if (!message && !attachments.length) return;
    // Typing while a turn runs queues the prompt instead of dropping it; the
    // queue drains one entry per busy → idle transition.
    if (this.busy) {
      this.pendingPrompts.push({ text: message, attachments });
      this.pendingAttachments = [];
      this.input.value = "";
      this.input.style.height = "auto";
      this.refreshAttachmentBar();
      return;
    }
    const cwd = this.getCwd();
    if (!cwd) {
      this.append("Open a folder first to chat with Claude about your project.", "note", true);
      return;
    }

    // Gate before echoing the message — e.g. LingModel requires a LingCode
    // sign-in; this may open the sign-in flow. Abort silently if it fails/cancels.
    if (!(await this.ensureAuth(this.getModel()))) return;

    this.clearOptions();
    const echo = attachments.length
      ? `${message}${message ? "  " : ""}📎 ${attachments.length}`
      : message;
    this.append(echo, "user", true, "You");
    // The queue is consumed by this turn; don't delete the files — the agent
    // reads them by path while the turn runs.
    this.pendingAttachments = [];
    this.refreshAttachmentBar();
    this.input.value = "";
    this.input.style.height = "auto";
    this.setBusy(true);
    this.interrupted = false;
    this.lastAssistantText = "";
    this.lastWrittenPath = null;
    this.startThinkingLine();

    try {
      await claudeSend(
        { message, cwd, model: this.getModel(), resume: this.session, attachments },
        (e) => this.handleEvent(e)
      );
    } catch (err) {
      this.append("Claude error: " + String(err), "note", true);
    } finally {
      this.stopThinkingLine();
      this.setBusy(false);
      await this.saveHistory();
      if (this.lastWrittenPath) this.onFileWritten(this.lastWrittenPath);
      this.drainPromptQueueIfIdle();
    }
  }

  /** Fire the next queued prompt. Held back while a question is on screen —
   *  the queued text would be read as the answer to it. */
  private drainPromptQueueIfIdle() {
    if (this.busy || !this.pendingPrompts.length) return;
    if (this.optionsEl.childElementCount > 0) return;
    const next = this.pendingPrompts.shift()!;
    this.pendingAttachments = next.attachments;
    this.refreshAttachmentBar();
    // Go through the same path a live click takes, so the transcript, thinking
    // indicator and CLI invocation are identical.
    void this.send(next.text);
  }

  private handleEvent(e: ChatEvent) {
    switch (e.kind) {
      case "session": this.session = e.id; break;
      case "thinking":
        this.append(`🧠 ${e.text}`, "thinking", false);
        break;
      case "text":
        this.lastAssistantText = e.text;
        this.append(e.text, "thinking", false);
        break;
      case "tool":
        this.append(`🔧 ${e.name} ${e.detail}`, "tool", false);
        break;
      case "edit": {
        const file = e.input?.file_path || e.input?.path;
        if (typeof file === "string" && file) this.lastWrittenPath = file;
        this.append(this.renderEdit(e.name, e.input), "edit", true);
        break;
      }
      case "ask_user":
        this.stopThinkingLine();
        this.showOptions(e.question, e.options);
        if (this.playSounds) beep(880);
        this.onAskUser();
        break;
      case "result":
        if (e.is_error) {
          this.append("Claude error: " + e.text, "note", true);
        } else if (e.text && e.text.trim() && e.text.trim() !== this.lastAssistantText.trim()) {
          this.append(e.text, "assistant", true, "Claude");
        } else if (this.lastAssistantText.trim()) {
          // Promote the streamed text to a final answer.
          this.append(this.lastAssistantText, "assistant", true, "Claude");
        }
        this.onFilesModified();
        break;
      case "awaiting":
        this.interrupted = true;
        break;
      case "done":
        if (!this.interrupted && this.playSounds) beep(660);
        if (e.stderr && this.transcript.childElementCount === 0) {
          this.append("Claude exited without output. " + e.stderr, "note", true);
        }
        this.onFilesModified();
        break;
    }
  }

  /** Build the plain-text diff body for an Edit/Write/MultiEdit tool call. The
   *  row is stored as this text and coloured per line at render time, so it
   *  looks the same after a restore. */
  private renderEdit(name: string, input: any): string {
    const file = input?.file_path || input?.path || "";
    let lines: string[] = [`✏️ ${name} ${file}`];
    const pushDiff = (oldS: string, newS: string) => {
      for (const l of String(oldS ?? "").split("\n")) lines.push(`- ${l}`);
      for (const l of String(newS ?? "").split("\n")) lines.push(`+ ${l}`);
    };
    if (name === "Write") {
      for (const l of String(input?.content ?? "").split("\n")) lines.push(`+ ${l}`);
    } else if (name === "MultiEdit" && Array.isArray(input?.edits)) {
      for (const ed of input.edits) pushDiff(ed.old_string, ed.new_string);
    } else {
      pushDiff(input?.old_string, input?.new_string);
    }
    if (lines.length > 81) { lines = lines.slice(0, 81); lines.push("…"); }
    return lines.join("\n");
  }

  private showOptions(question: string, options: string[]) {
    this.append(question, "assistant", true, "Claude");
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

/** Colour a stored diff body per line (`+` added, `-` removed, header cyan). */
function renderDiff(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  text.split("\n").forEach((line, i) => {
    const span = document.createElement("span");
    span.className = i === 0 ? "file" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    span.textContent = line;
    frag.appendChild(span);
    frag.appendChild(document.createTextNode("\n"));
  });
  return frag;
}

// Web links in prose become clickable and open in the default browser. Matches
// the Mac LCBResponseLinkifier: http/https only, and never inside a code span
// or fenced block (a URL in sample code is code, not a link).
const URL_RE = /https?:\/\/[^\s<>()[\]{}"'`]+[^\s<>()[\]{}"'`.,;:!?]/g;

function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /^[ ]{0,3}(`{3,}|~{3,})[^\n]*\n?/gm;
  let m: RegExpExecArray | null;
  const consumed: Array<[number, number]> = [];
  while ((m = fence.exec(text))) {
    const delim = m[1][0];
    const len = m[1].length;
    const bodyStart = m.index;
    const closing = new RegExp(`^[ ]{0,3}\\${delim}{${len},}[ \\t]*$`, "m");
    const rest = text.slice(fence.lastIndex);
    const close = closing.exec(rest);
    const end = close ? fence.lastIndex + close.index + close[0].length : text.length;
    consumed.push([bodyStart, end]);
    fence.lastIndex = end;
  }
  ranges.push(...consumed);
  // Inline spans, skipping anything already inside a fence.
  const inline = /`+[^`\n]*`+/g;
  while ((m = inline.exec(text))) {
    const start = m.index;
    if (consumed.some(([a, b]) => start >= a && start < b)) continue;
    ranges.push([start, start + m[0].length]);
  }
  return ranges;
}

function linkify(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const skip = codeRanges(text);
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    const start = m.index;
    if (skip.some(([a, b]) => start >= a && start < b)) continue;
    frag.appendChild(document.createTextNode(text.slice(last, start)));
    const a = document.createElement("a");
    a.className = "chat-link";
    a.textContent = m[0];
    a.href = "#";
    const href = m[0];
    a.onclick = async (ev) => {
      ev.preventDefault();
      try { await openUrl(href); }
      catch (e) { await alertDialog("Couldn't open the link: " + String(e)); }
    };
    frag.appendChild(a);
    last = start + m[0].length;
  }
  frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

/** ArrayBuffer → standard base64, chunked so a big screenshot doesn't blow the
 *  argument limit of String.fromCharCode. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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
