// The right-hand panel of the Simple workspace (SimplePanelPane.swift):
// Preview | Files | Review, collapsible to a 36px strip.
import { convertFileSrc } from "@tauri-apps/api/core";

export type TabKind = "preview" | "files" | "review";
const TABS: Array<{ kind: TabKind; title: string; icon: string }> = [
  { kind: "preview", title: "Preview", icon: "▶" },
  { kind: "files", title: "Files", icon: "📁" },
  { kind: "review", title: "Review", icon: "🔍" },
];

export interface ReviewItem { file: string; diff: string; }

export class PanelPane {
  onCollapsedChange: (collapsed: boolean) => void = () => {};
  /** The empty preview's Run app button; main.ts decides what running means. */
  onRunApp: () => void = () => {};
  /** Hosts main.ts mounts the file tree and the editor into. */
  readonly treeHost: HTMLElement;
  readonly editorHost: HTMLElement;
  readonly fileHead: HTMLElement;

  private root: HTMLElement;
  private strip: HTMLElement;
  private panes: Record<TabKind, HTMLElement>;
  private frame: HTMLIFrameElement;
  private urlEl: HTMLElement;
  private previewEmpty: HTMLElement;
  private reviewList: HTMLElement;
  private reviewHead: HTMLElement;
  private selected: TabKind = "preview";
  private collapsed = false;
  private previewUrl: string | null = null;
  hasFolder = false;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="panel-head">
        <div class="tab-strip"></div>
        <button class="btn icon collapse" title="Hide panel">⟩</button>
      </div>
      <div class="panel-body">
        <div class="tab-pane" data-tab="preview">
          <div class="browser-frame">
            <div class="address"><span class="lights"><i></i><i></i><i></i></span><button class="btn sm reload" title="Reload">↻</button><span class="url">Your app isn't running</span></div>
            <iframe class="preview-frame" title="Preview" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
            <div class="panel-empty preview-empty" hidden><span class="globe">🌐</span><b>Your app isn't running</b><span class="sub">Takes a moment to load</span><button class="btn primary run-preview">▶ Run app</button></div>
          </div>
        </div>
        <div class="tab-pane" data-tab="files">
          <div class="files-split">
            <div class="files-tree"></div>
            <div class="files-editor"><div class="file-head"><span class="file-name faint">No file open</span></div><div class="cm-host"></div></div>
          </div>
        </div>
        <div class="tab-pane" data-tab="review">
          <div class="address"><span class="review-head">No changes</span></div>
          <div class="review-list"></div>
        </div>
      </div>`;
    this.strip = root.querySelector(".tab-strip") as HTMLElement;
    this.panes = {
      preview: root.querySelector('[data-tab="preview"]') as HTMLElement,
      files: root.querySelector('[data-tab="files"]') as HTMLElement,
      review: root.querySelector('[data-tab="review"]') as HTMLElement,
    };
    this.frame = root.querySelector(".preview-frame") as HTMLIFrameElement;
    this.urlEl = root.querySelector(".address .url") as HTMLElement;
    this.previewEmpty = root.querySelector(".preview-empty") as HTMLElement;
    this.reviewList = root.querySelector(".review-list") as HTMLElement;
    this.reviewHead = root.querySelector(".review-head") as HTMLElement;
    this.treeHost = root.querySelector(".files-tree") as HTMLElement;
    this.editorHost = root.querySelector(".cm-host") as HTMLElement;
    this.fileHead = root.querySelector(".file-name") as HTMLElement;
    (root.querySelector(".btn.collapse") as HTMLButtonElement).onclick = () => this.setCollapsed(true);
    (root.querySelector(".btn.reload") as HTMLButtonElement).onclick = () => this.reloadPreview();
    (root.querySelector(".run-preview") as HTMLButtonElement).onclick = () => this.onRunApp();
    this.renderStrip();
    this.select(this.selected);
    this.setPreview(null);
    this.setReview([]);
  }

  select(tab: TabKind) {
    this.selected = tab;
    for (const k of Object.keys(this.panes) as TabKind[]) this.panes[k].classList.toggle("active", k === tab);
    this.renderStrip();
  }

  setCollapsed(collapsed: boolean) {
    if (this.collapsed === collapsed) return;
    this.collapsed = collapsed;
    this.root.classList.toggle("collapsed", collapsed);
    this.renderStrip();
    this.onCollapsedChange(collapsed);
  }
  isCollapsed() { return this.collapsed; }

  /** Point the Preview tab at the folder's index.html (or the empty state). */
  setPreview(indexPath: string | null) {
    this.previewUrl = indexPath ? convertFileSrc(indexPath) : null;
    this.urlEl.textContent = indexPath ? indexPath.split(/[\\/]/).slice(-2).join("/") : "Your app isn't running";
    this.frame.hidden = !indexPath;
    this.previewEmpty.hidden = !!indexPath;
    const sub = this.previewEmpty.querySelector(".sub") as HTMLElement;
    const run = this.previewEmpty.querySelector(".run-preview") as HTMLButtonElement;
    sub.textContent = this.hasFolder ? "No index.html in this folder yet — ask for one, then press Run app." : "Open a project, then press Run app.";
    run.hidden = !this.hasFolder;
    if (indexPath) this.reloadPreview(); else this.frame.removeAttribute("src");
  }

  reloadPreview() {
    if (!this.previewUrl) return;
    // A changing query defeats the webview cache so an edit shows up. A blob
    // URL (the dev mock) takes no query, so it is reloaded by reassigning.
    const u = this.previewUrl;
    this.frame.src = u.startsWith("blob:") ? u : u + (u.includes("?") ? "&" : "?") + "t=" + Date.now();
  }

  setReview(items: ReviewItem[]) {
    this.reviewHead.textContent = items.length ? `${items.length} changed file${items.length === 1 ? "" : "s"}` : "No changes";
    this.reviewList.innerHTML = "";
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "panel-empty";
      e.innerHTML = "<b>No changes</b><span>Edits the agent makes show up here.</span>";
      this.reviewList.appendChild(e);
      return;
    }
    for (const it of items) {
      const box = document.createElement("div");
      box.className = "review-file";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = it.file;
      const pre = document.createElement("pre");
      for (const line of it.diff.split("\n")) {
        const span = document.createElement("span");
        span.className = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
        span.textContent = line + "\n";
        pre.appendChild(span);
      }
      box.appendChild(name);
      box.appendChild(pre);
      this.reviewList.appendChild(box);
    }
  }

  private renderStrip() {
    this.strip.innerHTML = "";
    const head = this.root.querySelector(".panel-head") as HTMLElement;
    const collapseBtn = head.querySelector(".btn.collapse") as HTMLButtonElement;
    if (this.collapsed) {
      const cur = TABS.find((t) => t.kind === this.selected)!;
      const show = document.createElement("button");
      show.className = "btn icon";
      show.title = "Show panel";
      show.textContent = cur.icon;
      show.onclick = () => this.setCollapsed(false);
      this.strip.appendChild(show);
      collapseBtn.hidden = true;
      return;
    }
    collapseBtn.hidden = false;
    for (const t of TABS) {
      const b = document.createElement("button");
      b.className = "tab" + (t.kind === this.selected ? " selected" : "");
      b.title = t.title;
      b.innerHTML = `<span>${t.icon}</span><span class="tab-title">${t.title}</span>`;
      b.onclick = () => this.select(t.kind);
      this.strip.appendChild(b);
    }
  }
}
