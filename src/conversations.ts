// Many chats per folder, stored as <folder>/.lingcode/chats/<id>.json through
// the existing file commands — no Rust change. The Mac keeps its chats in
// ClaudeCodeHistoryService; this is the Baby equivalent, plus the 240-wide
// conversations pane that lists them (ConversationsPane.swift).
import { api } from "./api";
import { ChatDoc, ChatMeta, adoptLegacy, deriveTitle, groupByDay, newChatId } from "./simple-logic";

const CHATS_DIR = ".lingcode/chats";

export class ChatStore {
  private metas: ChatMeta[] | null = null;
  constructor(readonly folder: string) {}

  private dir() { return `${this.folder.replace(/[\\/]+$/, "")}/${CHATS_DIR}`; }
  private pathFor(id: string) { return `${this.dir()}/${id}.json`; }

  private async ensureDir() {
    const root = this.folder.replace(/[\\/]+$/, "");
    try { await api.createDir(root, ".lingcode"); } catch { /* exists */ }
    try { await api.createDir(`${root}/.lingcode`, "chats"); } catch { /* exists */ }
  }

  /** Metadata for every chat, newest first. Adopts the legacy single chat once. */
  async list(): Promise<ChatMeta[]> {
    if (this.metas) return this.metas;
    let entries: { name: string; path: string; is_dir: boolean }[] = [];
    try { entries = await api.listDir(this.dir()); } catch { entries = []; }
    const metas: ChatMeta[] = [];
    for (const e of entries) {
      if (e.is_dir || !e.name.endsWith(".json")) continue;
      try {
        const doc = JSON.parse(await api.readFile(e.path)) as ChatDoc;
        if (doc && doc.id) metas.push({ id: doc.id, title: doc.title || "New chat", createdAt: doc.createdAt || 0, updatedAt: doc.updatedAt || 0 });
      } catch { /* skip an unreadable file */ }
    }
    if (!metas.length) {
      // First launch on a folder the old single-chat build used: carry the
      // conversation over so nothing the user saw disappears. The legacy file
      // is left in place for the older build.
      let legacy = null;
      try { legacy = await api.historyLoad(this.folder); } catch { legacy = null; }
      const adopted = adoptLegacy(legacy, Date.now());
      if (adopted) { await this.save(adopted); metas.push(metaOf(adopted)); }
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    this.metas = metas;
    return metas;
  }

  async load(id: string): Promise<ChatDoc | null> {
    try { return JSON.parse(await api.readFile(this.pathFor(id))) as ChatDoc; } catch { return null; }
  }

  async save(doc: ChatDoc): Promise<void> {
    await this.ensureDir();
    await api.writeFile(this.pathFor(doc.id), JSON.stringify(doc));
    const metas = this.metas || [];
    const i = metas.findIndex((m) => m.id === doc.id);
    if (i >= 0) metas[i] = metaOf(doc); else metas.push(metaOf(doc));
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    this.metas = metas;
  }

  create(): ChatDoc {
    const now = Date.now();
    return { id: newChatId(now), title: "New chat", createdAt: now, updatedAt: now, session: null, model: null, messages: [] };
  }

  async remove(id: string): Promise<void> {
    try { await api.trashPath(this.pathFor(id)); } catch { /* already gone */ }
    if (this.metas) this.metas = this.metas.filter((m) => m.id !== id);
  }
}

function metaOf(doc: ChatDoc): ChatMeta {
  return { id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
}

/** Title for a chat that still says "New chat", once its first user message exists. */
export function titleFor(doc: ChatDoc): string {
  if (doc.title && doc.title !== "New chat") return doc.title;
  const first = doc.messages.find((m) => m.kind === "user");
  return first ? deriveTitle(first.text) : "New chat";
}

export class ConversationsPane {
  onSelect: (id: string) => void = () => {};
  onNew: () => void = () => {};
  onDelete: (id: string) => void = () => {};
  onHide: () => void = () => {};
  onSwitchProject: () => void = () => {};

  private listEl: HTMLElement;
  private projectEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private metas: ChatMeta[] = [];
  private activeId: string | null = null;
  private runningId: string | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="inner">
        <div class="conv-head">
          <button class="btn new" title="Start a new chat">＋ New chat</button>
          <button class="btn icon hide" title="Hide chats">⟨</button>
        </div>
        <div class="conv-search"><input class="field" placeholder="Search chats" /></div>
        <div class="conv-project"><div class="label">Projects</div><div class="row"><span class="folder-icon">📁</span><span class="name"></span></div></div>
        <div class="conv-list"></div>
        <div class="conv-foot">LingCodeBaby</div>
      </div>`;
    this.listEl = root.querySelector(".conv-list") as HTMLElement;
    this.projectEl = root.querySelector(".conv-project .name") as HTMLElement;
    this.searchEl = root.querySelector(".conv-search input") as HTMLInputElement;
    (root.querySelector(".btn.new") as HTMLButtonElement).onclick = () => this.onNew();
    (root.querySelector(".btn.hide") as HTMLButtonElement).onclick = () => this.onHide();
    (root.querySelector(".conv-project .row") as HTMLElement).onclick = () => this.onSwitchProject();
    this.searchEl.oninput = () => this.render();
  }

  setProject(name: string | null) {
    this.projectEl.textContent = name || "No project";
  }

  setChats(metas: ChatMeta[], activeId: string | null) {
    this.metas = metas;
    this.activeId = activeId;
    this.render();
  }

  setRunning(id: string | null) {
    this.runningId = id;
    this.render();
  }

  private render() {
    const q = this.searchEl.value.trim().toLowerCase();
    const shown = q ? this.metas.filter((m) => m.title.toLowerCase().includes(q)) : this.metas;
    this.listEl.innerHTML = "";
    if (!shown.length) {
      const e = document.createElement("div");
      e.className = "conv-empty";
      e.textContent = q ? "No chats match." : "No chats yet";
      this.listEl.appendChild(e);
      return;
    }
    for (const group of groupByDay(shown, Date.now())) {
      const g = document.createElement("div");
      g.className = "label conv-group";
      g.textContent = group.label.toUpperCase();
      this.listEl.appendChild(g);
      for (const m of group.chats) {
        const row = document.createElement("div");
        row.className = "conv-row" + (m.id === this.activeId ? " selected" : "");
        const title = document.createElement("span");
        title.className = "title";
        title.textContent = m.title;
        row.appendChild(title);
        if (m.id === this.runningId) {
          const dot = document.createElement("span");
          dot.className = "dot";
          dot.title = "Working on this chat";
          row.appendChild(dot);
        }
        const del = document.createElement("button");
        del.className = "del";
        del.textContent = "✕";
        del.title = "Delete chat";
        del.onclick = (ev) => { ev.stopPropagation(); this.onDelete(m.id); };
        row.appendChild(del);
        row.onclick = () => this.onSelect(m.id);
        this.listEl.appendChild(row);
      }
    }
  }
}
