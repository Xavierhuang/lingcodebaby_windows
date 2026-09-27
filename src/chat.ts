import { claudeSend, ChatEvent, api } from "./api";
import { ChatDoc, foldTurns, outcomeOptions } from "./simple-logic";
import { ChatStore, titleFor } from "./conversations";
import { openUrl } from "@tauri-apps/plugin-opener";
import { alertDialog } from "./ui";

/** Row kinds that survive a save/restore round-trip. Mirrors LCBBubbleKind. */
type Kind = "user" | "assistant" | "note" | "thinking" | "tool" | "edit";

interface Entry {
  el: HTMLElement;
  clean: boolean;   // shown even with "Show all steps" off
  kind: Kind;
  text: string;     // plain text, so the row can be re-rendered on restore
}

/** The Mac SimpleEmptyStateView chips, as prompts or actions. */
const EXPLAIN_PROMPT =
  "Explain what this app does in plain English, for someone who doesn't read code: " +
  "what it's for, its main screens, and what happens when I use each one. Keep it short.";

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
  /** The composer's model picker changed. main.ts persists it. */
  onModelChange: (model: string) => void = () => {};
  /** Empty-state chips that belong to the window, not the chat. */
  onRunApp: () => void = () => {};
  onPublish: () => void = () => {};
  onOpenFolder: () => void = () => {};
  /** A turn finished, or a chat was saved — the conversations list and the
   *  Review tab re-read from here. */
  onChatSaved: (doc: ChatDoc) => void = () => {};
  onBusyChange: (busy: boolean) => void = () => {};
  // Gate a send on required auth (e.g. LingModel needs a LingCode sign-in).
  // Return false to abort the send. Set from main.ts.
  ensureAuth: (model: string) => Promise<boolean> = async () => true;
  playSounds = true;
  private showThinking = false;
  private showAllSteps = false;
  private session: string | null = null;
  private busy = false;
  private interrupted = false;
  private root: string | null = null;
  private store: ChatStore | null = null;
  private doc: ChatDoc | null = null;
  private openFolds = new Set<number>();

  private transcript: HTMLElement;
  private emptyEl: HTMLElement;
  private optionsEl: HTMLElement;
  private attachEl: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private modelSelect: HTMLSelectElement;
  private stepsToggle: HTMLInputElement;
  private scrollEl: HTMLElement;
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
      <div class="chat-scroll"><div class="chat-column">
        <div class="empty-state" hidden></div>
        <div class="transcript"></div>
        <div class="options"></div>
      </div></div>
      <div class="composer-wrap"><div class="composer-inner">
        <div class="composer">
          <div class="attachments"></div>
          <textarea class="chat-input" placeholder="What should we work on?" rows="1"></textarea>
          <div class="composer-row"><span class="spacer"></span><button class="send-btn">Send</button></div>
        </div>
        <div class="composer-actions">
          <select class="model-select" title="Model"></select>
          <label class="steps-toggle"><input type="checkbox" class="steps"/> Show all steps</label>
        </div>
      </div></div>`;
    this.scrollEl = root.querySelector(".chat-scroll") as HTMLElement;
    this.emptyEl = root.querySelector(".empty-state") as HTMLElement;
    this.transcript = root.querySelector(".transcript") as HTMLElement;
    this.optionsEl = root.querySelector(".options") as HTMLElement;
    this.attachEl = root.querySelector(".attachments") as HTMLElement;
    this.input = root.querySelector(".chat-input") as HTMLTextAreaElement;
    this.sendBtn = root.querySelector(".send-btn") as HTMLButtonElement;
    this.modelSelect = root.querySelector(".model-select") as HTMLSelectElement;
    this.stepsToggle = root.querySelector(".steps") as HTMLInputElement;
    this.modelSelect.onchange = () => this.onModelChange(this.modelSelect.value);
    this.stepsToggle.onchange = () => this.setShowAllSteps(this.stepsToggle.checked);

    // Stop takes Send's place while a turn runs (the Mac's stopInComposer).
    this.sendBtn.onclick = () => { if (this.busy) this.abort(); else this.send(); };
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
      this.input.style.height = Math.min(this.input.scrollHeight, 160) + "px";
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
    // Drag & drop onto the composer.
    const composer = root.querySelector(".composer") as HTMLElement;
    root.addEventListener("dragover", (e) => { e.preventDefault(); composer.classList.add("drop-target"); });
    root.addEventListener("dragleave", () => composer.classList.remove("drop-target"));
    root.addEventListener("drop", (e) => {
      e.preventDefault();
      composer.classList.remove("drop-target");
      for (const file of Array.from(e.dataTransfer?.files ?? [])) this.attachFile(file);
    });

    this.renderEmptyState();
  }

  /** Fill the composer's model picker (Mac OutcomeModelPicker shape). */
  setModelOptions(names: Record<string, string>, current: string) {
    this.modelSelect.innerHTML = "";
    for (const group of outcomeOptions(names)) {
      const parent: HTMLElement = group.label ? Object.assign(document.createElement("optgroup"), { label: group.label }) : this.modelSelect;
      for (const o of group.options) {
        const opt = document.createElement("option");
        opt.value = o.value; opt.textContent = o.label;
        parent.appendChild(opt);
      }
      if (parent !== this.modelSelect) this.modelSelect.appendChild(parent);
    }
    this.modelSelect.value = current;
    if (this.modelSelect.value !== current) { const opt = document.createElement("option"); opt.value = current; opt.textContent = current; this.modelSelect.appendChild(opt); this.modelSelect.value = current; }
  }
  setCurrentModel(model: string) { this.modelSelect.value = model; }

  setShowAllSteps(on: boolean) {
    this.showAllSteps = on;
    this.stepsToggle.checked = on;
    this.applyFolds();
  }
  getShowAllSteps() { return this.showAllSteps; }

  prefill(text: string) { this.input.value = text; this.input.focus(); this.input.setSelectionRange(text.length, text.length); }

  /** Files the agent edited in this chat, newest first, for the Review tab. */
  editedFiles(): Array<{ file: string; diff: string }> {
    const out: Array<{ file: string; diff: string }> = [];
    for (const e of [...this.entries].reverse()) {
      if (e.kind !== "edit") continue;
      const nl = e.text.indexOf("\n");
      const head = nl >= 0 ? e.text.slice(0, nl) : e.text;
      const file = head.replace(/^✏️\s*\S+\s*/, "").trim() || "(file)";
      out.push({ file, diff: nl >= 0 ? e.text.slice(nl + 1) : "" });
    }
    return out;
  }

  // ---- project root / persistence -----------------------------------------

  /** Point the panel at a project folder's chat store, or none. */
  setStore(folder: string | null, store: ChatStore | null) {
    if (this.busy) this.abort();
    this.root = folder;
    this.store = store;
    this.doc = null;
    this.session = null;
    this.pendingAttachments = [];
    this.pendingPrompts = [];
    this.refreshAttachmentBar();
    this.clearOptions();
    this.resetTranscript();
    this.renderEmptyState();
  }

  /** Show one chat: its rows, and its CLI session id for `--resume`. */
  openChat(doc: ChatDoc) {
    if (this.busy) this.abort();
    this.doc = doc;
    this.session = doc.session ?? null;
    this.openFolds.clear();
    this.clearOptions();
    this.resetTranscript();
    for (const m of doc.messages) this.restoreRow(m);
    this.applyFolds();
    this.renderEmptyState();
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  currentChatId(): string | null { return this.doc ? this.doc.id : null; }

  private resetTranscript() {
    this.transcript.innerHTML = "";
    this.entries = [];
  }

  private async saveHistory() {
    if (!this.store || !this.doc || !this.entries.length) return;
    const doc: ChatDoc = {
      ...this.doc,
      session: this.session,
      model: this.getModel(),
      updatedAt: Date.now(),
      messages: this.entries.map((e) => ({ kind: e.kind, text: e.text, clean: e.clean })),
    };
    doc.title = titleFor(doc);
    this.doc = doc;
    try { await this.store.save(doc); } catch { /* a failed save must never break the chat */ }
    this.onChatSaved(doc);
  }

  private restoreRow(m: { kind: string; text: string; clean?: boolean }) {
    const kind = (m.kind || "note") as Kind;
    const role = kind === "user" ? "You" : kind === "assistant" ? "Claude" : undefined;
    this.append(m.text ?? "", kind, m.clean !== false, role, false);
  }

  private renderEmptyState() {
    const show = this.entries.length === 0;
    this.emptyEl.hidden = !show;
    if (!show) return;
    if (!this.root) {
      this.emptyEl.innerHTML = `<div class="no-project"><h1>Open a project to start</h1><span>Pick a folder and this becomes its chat.</span><button class="btn primary open">Open folder…</button></div>`;
      (this.emptyEl.querySelector(".open") as HTMLButtonElement).onclick = () => this.onOpenFolder();
      return;
    }
    this.emptyEl.innerHTML = `
      <h1>What should we work on?</h1>
      <div class="status">Ask for a change, or pick a starting point.</div>
      <div class="empty-grid">
        <button class="empty-chip" data-chip="run"><b>Run the app</b><span>Open the preview</span></button>
        <button class="empty-chip" data-chip="change"><b>Change something I see</b><span>Describe what to change</span></button>
        <button class="empty-chip" data-chip="publish"><b>Publish</b><span>Put it online</span></button>
        <button class="empty-chip" data-chip="explain"><b>Explain my app</b><span>Plain-English tour of what it does</span></button>
      </div>`;
    this.emptyEl.querySelectorAll<HTMLButtonElement>("[data-chip]").forEach((b) => {
      b.onclick = () => {
        switch (b.dataset.chip) {
          case "run": this.onRunApp(); break;
          case "change": this.prefill("Change the "); break;
          case "publish": this.onPublish(); break;
          case "explain": void this.send(EXPLAIN_PROMPT); break;
        }
      };
    });
  }

  /** Fold each finished turn's steps behind one summary line (Mac TranscriptTurnSummary). */
  private applyFolds() {
    this.transcript.querySelectorAll(".turn-summary").forEach((el) => el.remove());
    for (const e of this.entries) e.el.style.display = (this.showThinking || e.clean) ? "" : "none";
    if (this.showAllSteps) return;
    const folds = foldTurns(this.entries.map((e) => ({ kind: e.kind, text: e.text })));
    for (const f of folds) {
      const open = this.openFolds.has(f.start);
      const summary = document.createElement("button");
      summary.className = "turn-summary";
      summary.textContent = (open ? "▾ " : "▸ ") + f.summary;
      summary.title = open ? "Hide steps" : "Show steps";
      summary.onclick = () => { if (open) this.openFolds.delete(f.start); else this.openFolds.add(f.start); this.applyFolds(); };
      this.transcript.insertBefore(summary, this.entries[f.start].el);
      if (!open) for (let i = f.start; i <= f.end; i++) this.entries[i].el.style.display = "none";
    }
  }

  // ---- transcript ---------------------------------------------------------

  postNote(text: string) {
    this.append(text, "note", true);
  }

  setShowThinking(on: boolean) {
    this.showThinking = on;
    this.applyFolds();
  }

  isBusy() { return this.busy; }

  /** Render one row. `text` is kept verbatim so the row survives a save/restore
   *  round-trip; the HTML is derived from it per kind. */
  private append(text: string, kind: Kind, clean: boolean, role?: string, live = true) {
    const el = document.createElement("div");
    el.className = "msg " + kind;
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
    if (live) { this.emptyEl.hidden = true; this.scrollEl.scrollTop = this.scrollEl.scrollHeight; }
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
    if (!cwd || !this.store) {
      this.onOpenFolder();
      return;
    }
    if (!this.doc) this.doc = this.store.create();

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
      this.applyFolds();
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
    this.sendBtn.textContent = b ? "Stop" : "Send";
    this.sendBtn.classList.toggle("stop", b);
    this.onBusyChange(b);
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
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
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
