import { claudeSend, ChatEvent, api } from "./api";

interface Entry { el: HTMLElement; clean: boolean; }

export class ChatPanel {
  getCwd: () => string | null = () => null;
  onFilesModified: () => void = () => {};
  getModel: () => string = () => "sonnet";
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

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="transcript"></div>
      <div class="options"></div>
      <div class="chat-input-row">
        <textarea class="chat-input" placeholder="Ask Claude…" rows="1"></textarea>
        <button class="send-btn">Send</button>
      </div>`;
    this.transcript = root.querySelector(".transcript") as HTMLElement;
    this.optionsEl = root.querySelector(".options") as HTMLElement;
    this.input = root.querySelector(".chat-input") as HTMLTextAreaElement;
    this.sendBtn = root.querySelector(".send-btn") as HTMLButtonElement;
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
