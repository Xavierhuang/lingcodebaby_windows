import "./styles.css";
import { api } from "./api";
import { FileTree } from "./tree";
import { CodeEditor } from "./editor";
import { ChatPanel } from "./chat";
import { runDeploy } from "./deploy";
import { checkForUpdates } from "./updater";
import { alertDialog } from "./ui";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="toolbar">
    <span class="title">LingCodeBaby</span>
    <button class="tb deploy" disabled>Deploy</button>
  </div>
  <div class="panes">
    <div class="sidebar">
      <div class="tree-header">Files</div>
      <div class="tree"></div>
    </div>
    <div class="divider" data-target="sidebar"></div>
    <div class="editor-pane">
      <div class="cm-host"></div>
    </div>
    <div class="divider" data-target="chat"></div>
    <div class="chat-pane">
      <div class="chat-head">
        Claude
        <span class="spacer"></span>
        <span class="model-label" title="Change in View → Claude Model"></span>
      </div>
      <div class="chat-body" style="flex:1;display:flex;flex-direction:column;min-height:0;"></div>
    </div>
  </div>`;

const treeEl = app.querySelector(".tree") as HTMLElement;
const cmHost = app.querySelector(".cm-host") as HTMLElement;
const chatBody = app.querySelector(".chat-body") as HTMLElement;
const deployBtn = app.querySelector(".deploy") as HTMLButtonElement;
const titleEl = app.querySelector(".toolbar .title") as HTMLElement;
const modelLabel = app.querySelector(".model-label") as HTMLElement;

// Current Claude model — controlled from the View → Claude Model menu.
let currentModel = "sonnet";
const MODEL_NAMES: Record<string, string> = {
  default: "Default", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku",
};
function setModel(m: string, persist = true) {
  currentModel = m;
  modelLabel.textContent = MODEL_NAMES[m] || m;
  if (persist) persistPrefs();
}
setModel(currentModel, false); // show a default until prefs load

const tree = new FileTree(treeEl);
const editor = new CodeEditor(cmHost);
const chat = new ChatPanel(chatBody);

let currentFile: string | null = null;
let dirty = false;
let folder: string | null = null;

// ---- wiring ----
chat.getCwd = () => folder;
chat.getModel = () => currentModel;
chat.onFilesModified = async () => {
  await tree.refreshAll();
  if (currentFile) await reloadCurrentFromDisk();
};

tree.onOpenFile = (path) => openFile(path);

editor.onChange = () => { if (!dirty) { dirty = true; updateTitle(); } };

deployBtn.onclick = () => runDeploy(folder);

async function openFile(path: string) {
  try {
    const text = await api.readFile(path);
    currentFile = path;
    dirty = false;
    editor.setContent(text, path);
    editor.focus();
    updateTitle();
  } catch (e) {
    await alertDialog("Couldn't open file: " + String(e));
  }
}

async function reloadCurrentFromDisk() {
  if (!currentFile) return;
  try {
    const text = await api.readFile(currentFile);
    if (text !== editor.getContent()) {
      editor.setContent(text, currentFile);
      dirty = false;
      updateTitle();
    }
  } catch { /* file may have been deleted */ }
}

async function saveFile() {
  if (!currentFile) {
    const path = await open({ directory: false, multiple: false, title: "Save As" });
    if (!path || typeof path !== "string") return;
    currentFile = path;
  }
  try {
    await api.writeFile(currentFile, editor.getContent());
    dirty = false;
    updateTitle();
  } catch (e) {
    await alertDialog("Couldn't save: " + String(e));
  }
}

async function doOpenFile() {
  const path = await open({ directory: false, multiple: false });
  if (path && typeof path === "string") await openFile(path);
}

async function doOpenFolder() {
  const path = await open({ directory: true, multiple: false });
  if (path && typeof path === "string") {
    folder = path;
    await tree.setRoot(path);
    deployBtn.disabled = false;
    updateTitle();
    // Scaffold screenshot/visual-regression support (no-op unless the bridge is installed).
    try {
      const note = await api.scaffoldAgentFiles(path);
      if (note) chat.postNote(note);
    } catch { /* non-fatal */ }
  }
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function updateTitle() {
  let name = "Untitled";
  if (currentFile) name = baseName(currentFile);
  else if (folder) name = baseName(folder);
  const t = (dirty ? "• " : "") + name + " — LingCodeBaby";
  titleEl.textContent = name + (dirty ? " •" : "");
  document.title = t;
  getCurrentWindow().setTitle(t).catch(() => {});
}

async function persistPrefs() {
  try { await api.setPrefs({ model: currentModel, play_sounds: chat.playSounds }); } catch { /* ignore */ }
}

// ---- splitters ----
function setupDivider(divider: HTMLElement) {
  const target = divider.dataset.target!;
  const pane = app.querySelector(target === "sidebar" ? ".sidebar" : ".chat-pane") as HTMLElement;
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = pane.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const w = target === "sidebar" ? startW + delta : startW - delta;
      pane.style.width = Math.max(150, Math.min(700, w)) + "px";
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
app.querySelectorAll<HTMLElement>(".divider").forEach(setupDivider);

// ---- keyboard (in-webview, complements native menu accelerators) ----
window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveFile(); }
});

// ---- native menu events ----
listen<string>("menu", async (ev) => {
  const id = ev.payload;
  if (id.startsWith("model:")) {
    setModel(id.slice("model:".length));
    return;
  }
  switch (id) {
    case "open_file": await doOpenFile(); break;
    case "open_folder": await doOpenFolder(); break;
    case "save": await saveFile(); break;
    case "deploy": await runDeploy(folder); break;
    case "find": editor.openFind(); break;
    case "find_next": editor.findNext(); break;
    case "find_prev": editor.findPrev(); break;
    case "check_updates": await checkForUpdates(false); break;
    case "stop_claude": chat.abort(); break;
    case "thinking:on": chat.setShowThinking(true); break;
    case "thinking:off": chat.setShowThinking(false); break;
    case "sounds:on": chat.playSounds = true; persistPrefs(); break;
    case "sounds:off": chat.playSounds = false; persistPrefs(); break;
  }
});

// ---- init prefs ----
(async () => {
  try {
    const prefs = await api.getPrefs();
    setModel(prefs.model, false);
    chat.playSounds = prefs.play_sounds;
  } catch { /* defaults are fine */ }
  updateTitle();
  // Quietly check for updates a few seconds after launch.
  setTimeout(() => checkForUpdates(true), 4000);
})();
