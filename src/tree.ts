import { api, DirEntry } from "./api";
import { promptText, confirmDialog, alertDialog, contextMenu } from "./ui";

interface TreeNode {
  entry: DirEntry;
  el: HTMLElement;        // the .node row
  childrenEl?: HTMLElement; // container for child rows
  expanded: boolean;
  loaded: boolean;
  depth: number;
}

const FOLDER = "\u{1F4C1}";

// Per-filetype glyphs, the cross-platform stand-in for NSWorkspace file icons.
const ICONS: Record<string, string> = {
  js: "\u{1F4DC}", jsx: "\u{1F4DC}", ts: "\u{1F4DC}", tsx: "\u{1F4DC}", mjs: "\u{1F4DC}", cjs: "\u{1F4DC}",
  py: "\u{1F40D}", rb: "\u{1F48E}", go: "\u{1F439}", rs: "\u{1F980}",
  c: "\u{1F527}", h: "\u{1F527}", cpp: "\u{1F527}", cc: "\u{1F527}", hpp: "\u{1F527}",
  m: "\u{1F527}", mm: "\u{1F527}",
  json: "\u{1F4CB}", css: "\u{1F3A8}", scss: "\u{1F3A8}",
  html: "\u{1F310}", htm: "\u{1F310}", php: "\u{1F418}",
  md: "\u{1F4DD}", txt: "\u{1F4C4}", sh: "\u{1F41A}", bash: "\u{1F41A}",
  png: "\u{1F5BC}", jpg: "\u{1F5BC}", jpeg: "\u{1F5BC}", gif: "\u{1F5BC}", svg: "\u{1F5BC}", ico: "\u{1F5BC}",
  lock: "\u{1F512}", toml: "\u{2699}", yml: "\u{2699}", yaml: "\u{2699}",
};

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "makefile" || lower === "dockerfile") return "\u{2699}";
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return ICONS[ext] || "\u{1F4C4}";
}

export class FileTree {
  rootPath: string | null = null;
  onOpenFile: (path: string) => void = () => {};
  private container: HTMLElement;
  private selectedEl: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async setRoot(path: string) {
    this.rootPath = path;
    this.container.innerHTML = "";
    const entries = await api.listDir(path);
    for (const e of entries) this.renderNode(e, this.container, 0);
  }

  async refreshAll() {
    if (this.rootPath) await this.setRoot(this.rootPath);
  }

  private renderNode(entry: DirEntry, parent: HTMLElement, depth: number) {
    const el = document.createElement("div");
    el.className = "node";
    el.style.paddingLeft = 8 + depth * 14 + "px";
    const node: TreeNode = { entry, el, expanded: false, loaded: false, depth };

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = entry.is_dir ? "▶" : "";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = entry.is_dir ? FOLDER : fileIcon(entry.name);
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.name;
    el.append(twisty, icon, label);
    parent.appendChild(el);

    el.onclick = (ev) => {
      ev.stopPropagation();
      this.select(el);
      if (entry.is_dir) this.toggle(node, twisty);
      else this.onOpenFile(entry.path);
    };
    el.ondblclick = (ev) => { ev.stopPropagation(); this.beginRename(node, label); };
    el.oncontextmenu = (ev) => {
      ev.preventDefault();
      this.select(el);
      this.showMenu(node, ev.clientX, ev.clientY);
    };
    return node;
  }

  private select(el: HTMLElement) {
    this.selectedEl?.classList.remove("selected");
    el.classList.add("selected");
    this.selectedEl = el;
  }

  private async toggle(node: TreeNode, twisty: HTMLElement) {
    if (node.expanded) {
      node.expanded = false;
      twisty.textContent = "▶";
      node.childrenEl?.remove();
      node.childrenEl = undefined;
      node.loaded = false;
      return;
    }
    node.expanded = true;
    twisty.textContent = "▼";
    const childrenEl = document.createElement("div");
    node.el.after(childrenEl);
    node.childrenEl = childrenEl;
    const entries = await api.listDir(node.entry.path);
    for (const e of entries) this.renderNode(e, childrenEl, node.depth + 1);
    node.loaded = true;
  }

  private async beginRename(node: TreeNode, label: HTMLElement) {
    const input = document.createElement("input");
    input.className = "rename";
    input.value = node.entry.name;
    label.replaceWith(input);
    input.focus();
    input.select();
    const finish = async (commit: boolean) => {
      const newName = input.value.trim();
      const restore = document.createElement("span");
      restore.className = "label";
      restore.textContent = node.entry.name;
      input.replaceWith(restore);
      if (commit && newName && newName !== node.entry.name) {
        try {
          await api.renamePath(node.entry.path, newName);
          await this.refreshAll();
        } catch (e) { await alertDialog(String(e)); }
      }
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    };
    input.onblur = () => finish(true);
  }

  private showMenu(node: TreeNode, x: number, y: number) {
    const dirOf = node.entry.is_dir ? node.entry.path : this.parentOf(node.entry.path);
    contextMenu(x, y, [
      { label: "New File…", action: async () => {
        const name = await promptText("New file name:", "untitled.txt");
        if (!name) return;
        try { const p = await api.createFile(dirOf, name); await this.refreshAll(); this.onOpenFile(p); }
        catch (e) { await alertDialog(String(e)); }
      }},
      { label: "New Folder…", action: async () => {
        const name = await promptText("New folder name:", "untitled folder");
        if (!name) return;
        try { await api.createDir(dirOf, name); await this.refreshAll(); }
        catch (e) { await alertDialog(String(e)); }
      }},
      { label: "Rename…", action: async () => {
        const name = await promptText("Rename to:", node.entry.name);
        if (!name || name === node.entry.name) return;
        try { await api.renamePath(node.entry.path, name); await this.refreshAll(); }
        catch (e) { await alertDialog(String(e)); }
      }},
      { label: "Move to Trash", action: async () => {
        if (!(await confirmDialog(`Move "${node.entry.name}" to Trash?`, "Move to Trash"))) return;
        try { await api.trashPath(node.entry.path); await this.refreshAll(); }
        catch (e) { await alertDialog(String(e)); }
      }},
      { label: "Reveal in File Manager", action: () => api.revealInExplorer(node.entry.path) },
    ]);
  }

  private parentOf(path: string): string {
    return path.replace(/[\\/][^\\/]+$/, "") || path;
  }
}
