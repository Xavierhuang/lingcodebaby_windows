import "./styles.css";
import { api, type RunTarget } from "./api";
import { FileTree } from "./tree";
import { CodeEditor } from "./editor";
import { ChatPanel } from "./chat";
import { ChatStore, ConversationsPane } from "./conversations";
import { PanelPane } from "./panel";
import { showSettings } from "./settings";
import { RemoteHost } from "./remote";
import { PANE, badgeForTarget, nativeRunText, paneLayout } from "./simple-logic";
import { runDeploy } from "./deploy";
import { checkForUpdates } from "./updater";
import { alertDialog, promptText, confirmDialog } from "./ui";
import { showEndpointSheet } from "./endpoint";
import { showOnboarding, showOnboardingIfNeeded } from "./onboarding";
import { connectBackendToFolder, openBackendConsole } from "./cloud";
import { Appearance, applyAppearance, isDark, onAppearanceChange } from "./theme";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

// The Simple workspace: 48px top bar over conversations | chat | panel.
// Widths and behaviour follow the Mac app's SimpleWorkspaceView.
const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="topbar">
    <div class="project">
      <span class="project-name none">Open a project to start</span>
      <span class="pill kind" hidden></span>
    </div>
    <span class="spacer"></span>
    <button class="btn primary run" hidden title="Reload the preview">▶ Run app</button>
    <button class="btn publish" hidden title="Put this project online">↑ Publish</button>
    <button class="btn share" title="Invite a helper: they can chat with this PC's agent for 2 hours">Share…</button>
    <span class="pill helper-live" hidden title="A helper link is active"></span>
    <button class="btn icon settings" title="Settings">⚙</button>
  </div>
  <div class="panes">
    <div class="conversations"></div>
    <div class="pane-divider conv-divider"></div>
    <div class="chat"><button class="btn icon show-chats" hidden title="Show chats">⟩</button><div class="chat-body"></div></div>
    <div class="pane-divider drag" data-target="panel"></div>
    <div class="panel"></div>
  </div>`;

const el = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
const projectName = el<HTMLElement>(".project-name");
const kindPill = el<HTMLElement>(".pill.kind");
const runBtn = el<HTMLButtonElement>(".btn.run");
const publishBtn = el<HTMLButtonElement>(".btn.publish");
const shareBtn = el<HTMLButtonElement>(".btn.share");
const helperPill = el<HTMLElement>(".pill.helper-live");
const settingsBtn = el<HTMLButtonElement>(".btn.settings");
const conversationsEl = el<HTMLElement>(".conversations");
const convDivider = el<HTMLElement>(".conv-divider");
const showChatsBtn = el<HTMLButtonElement>(".show-chats");
const chatEl = el<HTMLElement>(".chat");
const panelEl = el<HTMLElement>(".panel");
const panelDivider = el<HTMLElement>(".pane-divider.drag");

// Current Claude model — the composer picker and View → Claude Model agree.
let currentModel = "lingmodel";
const MODEL_NAMES: Record<string, string> = {
  lingmodel: "LingModel", default: "Default", opus: "Opus", opus55: "Opus 5.5", sonnet: "Sonnet",
  fable51: "Fable 5.1", fable: "Fable", haiku: "Haiku",
  "deepseek-v4-pro": "DeepSeek V4 Pro", "deepseek-v4-flash": "DeepSeek V4 Flash",
};

const conversations = new ConversationsPane(conversationsEl);
const chat = new ChatPanel(el(".chat-body"));
const panel = new PanelPane(panelEl);
const tree = new FileTree(panel.treeHost);
const editor = new CodeEditor(panel.editorHost, isDark());

chat.setModelOptions(MODEL_NAMES, currentModel);
function setModel(m: string, persist = true) {
  currentModel = m;
  chat.setCurrentModel(m);
  if (persist) persistPrefs();
}
chat.onModelChange = (m) => setModel(m);

// CodeMirror picks its palette in JS, so it can't follow the CSS token blocks —
// push each change into it. Fires immediately with the current state, and again
// whenever the menu or the OS flips.
onAppearanceChange((dark) => editor.setDark(dark));

let currentAppearance: Appearance = "system";
function setAppearance(mode: Appearance, persist = true) {
  currentAppearance = mode;
  applyAppearance(mode);
  if (persist) persistPrefs();
}

let currentFile: string | null = null;
let dirty = false;
let folder: string | null = null;
let store: ChatStore | null = null;
/** What Run app starts for the open folder (runapp.rs); null = nothing yet. */
let runTarget: RunTarget | null = null;
let runPoll: number | undefined;

// ---- layout: pane widths + collapse, persisted in localStorage --------------
const LS = { conv: "lingcodebaby.simple.conversationsCollapsed", panelW: "lingcodebaby.simple.panelWidth", panelC: "lingcodebaby.simple.panelCollapsed", steps: "lingcodebaby.simple.showAllSteps" };
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
let conversationsHidden = lsGet(LS.conv) === "1";
let panelWidth = Math.max(PANE.previewMinimum, Number(lsGet(LS.panelW)) || PANE.preview);
panel.setCollapsed(lsGet(LS.panelC) === "1");

function applyLayout() {
  const { conversations: convW, panel: panelW } = paneLayout(window.innerWidth, {
    panelWidth, conversationsHidden, panelHidden: panel.isCollapsed(),
  });
  conversationsEl.classList.toggle("collapsed", convW === 0);
  convDivider.hidden = convW === 0;
  showChatsBtn.hidden = convW !== 0;
  const stripOnly = panelW === PANE.previewCollapsed;
  panelDivider.classList.toggle("drag", !stripOnly);
  panelEl.style.width = panelW + "px";
  chatEl.style.minWidth = PANE.chatMinimum + "px";
}
window.addEventListener("resize", applyLayout);
conversations.onHide = () => { conversationsHidden = true; lsSet(LS.conv, "1"); applyLayout(); };
showChatsBtn.onclick = () => { conversationsHidden = false; lsSet(LS.conv, "0"); applyLayout(); };
panel.onCollapsedChange = (c) => { lsSet(LS.panelC, c ? "1" : "0"); applyLayout(); };
panelDivider.addEventListener("mousedown", (e) => {
  if (panel.isCollapsed()) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = panelEl.getBoundingClientRect().width;
  const move = (ev: MouseEvent) => {
    const max = window.innerWidth - (conversationsHidden ? 0 : PANE.conversations + PANE.divider) - PANE.chatMinimum - PANE.dragBand;
    panelWidth = Math.max(PANE.previewMinimum, Math.min(max, startW - (ev.clientX - startX)));
    applyLayout();
  };
  const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); lsSet(LS.panelW, String(Math.round(panelWidth))); };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
});
chat.setShowAllSteps(lsGet(LS.steps) === "1");

// ---- wiring ----
chat.getCwd = () => folder;
chat.getModel = () => currentModel;
chat.onFilesModified = async () => {
  await tree.refreshAll();
  if (currentFile) await reloadCurrentFromDisk();
  panel.setReview(chat.editedFiles());
  panel.reloadPreview();
};
// The agent wrote a file — show it in the Files tab's editor, like the Mac
// ClaudeChatDelegate claudeChat:didWriteFileAtPath: hook does.
chat.onFileWritten = async (path) => {
  if (path && path !== currentFile) await openFile(path, false);
};
chat.onAskUser = async () => {
  try {
    const win = getCurrentWindow();
    if (!(await win.isFocused())) await win.requestUserAttention(UserAttentionType.Informational);
  } catch { /* not fatal — the chime already fired */ }
};
chat.onRunApp = () => runApp();
panel.onRunApp = () => runApp();
chat.onPublish = () => runDeploy(folder);
chat.onOpenFolder = () => doOpenFolder();
chat.onChatSaved = () => refreshConversations();
chat.onBusyChange = (busy) => {
  conversations.setRunning(busy ? chat.currentChatId() : null);
  runBtn.disabled = busy;
  runBtn.title = busy ? "Wait for the current reply to finish — the app is being changed right now." : "Run your app";
};

conversations.onNew = () => newChat();
conversations.onSelect = (id) => selectChat(id);
conversations.onDelete = (id) => deleteChat(id);
conversations.onSwitchProject = () => doOpenFolder();

tree.onOpenFile = (path) => openFile(path, true);
editor.onChange = () => { if (!dirty) { dirty = true; updateFileHead(); } };

runBtn.onclick = () => runApp();
publishBtn.onclick = () => runDeploy(folder);
shareBtn.onclick = () => { void inviteHelper(); };
helperPill.onclick = () => { void stopSharing(); };
settingsBtn.onclick = () => openSettings();
function openSettings() { return showSettings(
  { appearance: currentAppearance, playSounds: chat.playSounds, showAllSteps: chat.getShowAllSteps(),
    remoteAccess: remoteOn, remoteStatus: remote.statusText },
  {
    onAppearance: (a) => setAppearance(a),
    onSounds: (on) => { chat.playSounds = on; persistPrefs(); },
    onShowAllSteps: (on) => { chat.setShowAllSteps(on); lsSet(LS.steps, on ? "1" : "0"); },
    onRemoteAccess: (on) => { void setRemoteAccess(on); },
    anthropicKey: doConfigureAnthropicKey,
    deepseekKey: doConfigureDeepSeekKey,
    customEndpoint: showEndpointSheet,
    signOut: doSignOut,
    checkUpdates: () => checkForUpdates(false),
    welcome: () => showOnboarding(false),
  },
); }

// ---- remote access + "Invite a helper" --------------------------------------
// remote.ts mirrors the open chat to lingcode.dev/remote; a helper link lets
// someone else chat with it for two hours.
const remote = new RemoteHost(chat, () => (folder ? `${baseName(folder)} · ` : "") + "LingCodeBaby chat");
let remoteOn = false;
let helperTimer: number | undefined;

async function setRemoteAccess(on: boolean) {
  remoteOn = on;
  try { const p = await api.getPrefs(); await api.setPrefs({ ...p, remote_access: on }); } catch { /* keep going */ }
  if (on) await remote.start(); else { remote.stop(); setHelperPill(0); }
}

function setHelperPill(until: number) {
  window.clearTimeout(helperTimer);
  helperPill.hidden = !until || until < Date.now();
  if (helperPill.hidden) return;
  const at = new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  helperPill.textContent = `🙋 Helper can chat until ${at} · Stop`;
  helperTimer = window.setTimeout(() => setHelperPill(0), until - Date.now());
}

async function inviteHelper() {
  const ok = await confirmDialog(
    "Invite a helper?\n\nThey get a link that lets them chat with this PC's AI agent for 2 hours. The agent can change files and run programs on this PC, so only invite someone you trust. You can stop it any time.",
    "Create link");
  if (!ok) return;
  if (!remoteOn) await setRemoteAccess(true);
  try {
    const link = await api.remoteCreateHelperLink();
    try { await navigator.clipboard.writeText(link.url); } catch { /* shown below */ }
    setHelperPill(link.expiresAt);
    await alertDialog(`Helper link copied. Send it to your helper:\n\n${link.url}\n\nIt works for 2 hours, while LingCodeBaby is open. Click the 🙋 Helper pill at the top to stop it early.`);
  } catch (e) {
    await alertDialog(`Couldn't create a helper link: ${String(e)}`);
  }
}

async function stopSharing() {
  if (!(await confirmDialog("Stop sharing? Your helper's link stops working right away.", "Stop sharing"))) return;
  try { await api.remoteStopSharing(); setHelperPill(0); }
  catch (e) { await alertDialog(`Couldn't stop sharing: ${String(e)}`); }
}

remote.onStatus = (status) => {
  shareBtn.classList.toggle("live", status === "online");
};
void (async () => {
  try { const p = await api.getPrefs(); if (p.remote_access) { remoteOn = true; await remote.start(); } } catch { /* off */ }
})();

async function runApp() {
  if (!folder) { doOpenFolder(); return; }
  panel.setCollapsed(false);
  panel.select("preview");
  // Look again: the agent may just have built the app or written .lingcode/run.json.
  await refreshRunTarget();
  if (!runTarget || runTarget.kind === "web") { panel.reloadPreview(); return; }
  const label = runTarget.label;
  panel.setNativeRun(nativeRunText(label, null, true));
  try {
    await api.runStart(folder);
    window.setTimeout(() => { void refreshRunStatus(); }, 2500);
  } catch (e) {
    panel.setNativeRun(nativeRunText(label, false), `Couldn't start ${label}: ${String(e)}`);
  }
}

/** Point the Preview at the folder's web page, or at its app's running state. */
async function refreshRunTarget() {
  if (!folder) return;
  try { runTarget = await api.runTarget(folder); } catch { runTarget = null; }
  kindPill.textContent = badgeForTarget(runTarget);
  if (runTarget?.kind === "web" && runTarget.path) {
    panel.setPreview(runTarget.path);
  } else if (runTarget) {
    panel.setNativeRun(nativeRunText(runTarget.label, null));
    void refreshRunStatus();
  } else {
    panel.setPreview(null);
  }
  window.clearInterval(runPoll);
  // Only a Windows program can be checked by name; poll it so the Preview
  // tracks the user starting or quitting it outside LingCodeBaby.
  if (runTarget?.kind === "open" && runTarget.path?.toLowerCase().endsWith(".exe")) {
    runPoll = window.setInterval(() => { void refreshRunStatus(); }, 3000);
  }
}

async function refreshRunStatus() {
  if (!folder || !runTarget || runTarget.kind === "web") return;
  let running: boolean | null = null;
  try { running = (await api.runStatus(folder)).running; } catch { running = null; }
  panel.setNativeRun(nativeRunText(runTarget.label, running));
}

// ---- chats -----------------------------------------------------------------
async function refreshConversations() {
  if (!store) { conversations.setChats([], null); return; }
  conversations.setChats(await store.list(), chat.currentChatId());
}

async function newChat() {
  if (!store) { doOpenFolder(); return; }
  chat.openChat(store.create());
  await refreshConversations();
}

async function selectChat(id: string) {
  if (!store) return;
  const doc = await store.load(id);
  if (doc) { chat.openChat(doc); panel.setReview(chat.editedFiles()); }
  await refreshConversations();
}

async function deleteChat(id: string) {
  if (!store) return;
  const ok = await confirmDialog("Delete this chat?\n\nIts transcript is moved to the Recycle Bin. Claude forgets the context. It can't be undone from here.", "Delete");
  if (!ok) return;
  await store.remove(id);
  if (chat.currentChatId() === id) await openLatestOrNew();
  else await refreshConversations();
}

async function openLatestOrNew() {
  if (!store) return;
  const metas = await store.list();
  if (metas.length) await selectChat(metas[0].id);
  else await newChat();
}

// ---- files -----------------------------------------------------------------
async function openFile(path: string, focus: boolean) {
  try {
    const text = await api.readFile(path);
    currentFile = path;
    dirty = false;
    editor.setContent(text, path);
    panel.select("files");
    if (focus) editor.focus();
    updateFileHead();
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
      updateFileHead();
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
    updateFileHead();
    panel.reloadPreview();
  } catch (e) {
    await alertDialog("Couldn't save: " + String(e));
  }
}

async function doOpenFile() {
  const path = await open({ directory: false, multiple: false });
  if (path && typeof path === "string") await openFile(path, true);
}

async function doOpenFolder() {
  const path = await open({ directory: true, multiple: false });
  if (path && typeof path === "string") await loadFolder(path);
}

async function loadFolder(path: string) {
  folder = path;
  store = new ChatStore(path);
  currentFile = null;
  dirty = false;
  await tree.setRoot(path);
  conversations.setProject(baseName(path));
  projectName.textContent = baseName(path);
  projectName.classList.remove("none");
  runBtn.hidden = false;
  publishBtn.hidden = false;
  kindPill.hidden = false;
  panel.hasFolder = true;
  await refreshRunTarget();
  chat.setStore(path, store);
  updateFileHead();
  updateTitle();
  await openLatestOrNew();
  // Wire the LingCode Cloud backend for signed-in users and say so once — the
  // feature is otherwise silent, and "connected" is easy to mistake for
  // "provisioned". Mirrors the Mac note in scaffoldCloudBackend:.
  try {
    if (await api.cloudAutoconnectBackend(path)) {
      chat.postNote(
        "☁️ LingCode Cloud backend connected for this folder — ask the agent to " +
        "add a database, user accounts, or file storage and it will provision one automatically.",
      );
    }
  } catch { /* non-fatal */ }
  // Scaffold screenshot/visual-regression support (no-op unless the bridge is installed).
  try {
    const note = await api.scaffoldAgentFiles(path);
    if (note) chat.postNote(note);
  } catch { /* non-fatal */ }
}

// File → New Quinny Project…  Mirrors EditorWindowController.m newQuinnyProject:
// (Mac Cmd-Shift-N). Prompts for parent folder + project name + one-sentence
// description, then runs `quinny gen "<desc>" -o <folder>/project.qn` and
// opens the resulting folder in this window.
async function doNewQuinnyProject() {
  const name = await promptText("New Quinny project (folder name):", "MyProject");
  if (!name) return;
  const description = await promptText(
    "Describe the project in one sentence:",
    "a Slack clone with channels, DMs, threads, and search",
  );
  if (!description) return;
  const parent = await open({
    directory: true,
    multiple: false,
    defaultPath: folder ?? undefined,
    title: "Choose parent folder for the new project",
  });
  if (!parent || typeof parent !== "string") return;
  const projectPath = `${parent.replace(/[\\/]+$/, "")}/${name}`;
  try {
    await api.quinnyNewProject(projectPath, description);
    await loadFolder(projectPath);
  } catch (e) {
    await alertDialog("Quinny generation failed:\n\n" + String(e));
  }
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function updateFileHead() {
  panel.fileHead.textContent = currentFile ? (dirty ? "• " : "") + baseName(currentFile) : "No file open";
  panel.fileHead.classList.toggle("faint", !currentFile);
  updateTitle();
}

function updateTitle() {
  const name = folder ? baseName(folder) : "LingCodeBaby";
  const t = (dirty ? "• " : "") + name + (folder ? " — LingCodeBaby" : "");
  document.title = t;
  getCurrentWindow().setTitle(t).catch(() => {});
}

async function persistPrefs() {
  // Fetch-merge-set: the Prefs shape carries endpoint + onboarding fields owned
  // by other subsystems. Sending just {model, play_sounds} would clobber them
  // back to Rust defaults. Read current first, apply just the fields we own.
  try {
    const current = await api.getPrefs();
    await api.setPrefs({
      ...current,
      model: currentModel,
      play_sounds: chat.playSounds,
      appearance: currentAppearance,
    });
  } catch { /* ignore */ }
}

// Prompt for a personal Anthropic API key and save it into the OS Keychain.
// Mirrors Mac's inline key-entry sheet (LCBAnthropicKey callers). Passing an
// empty string clears the stored key.
async function doConfigureAnthropicKey() {
  const present = await api.anthropicKeyPresent();
  const prompt = present
    ? "Anthropic API key (currently stored — leave empty to keep, or type a new one to replace; type 'delete' to clear):"
    : "Paste your Anthropic API key (sk-ant-…). Stored in the OS Keychain, never on disk:";
  const value = await promptText(prompt, "");
  if (value === null) return; // cancelled — no change
  try {
    if (value.trim().toLowerCase() === "delete") {
      await api.anthropicKeyDelete();
      await alertDialog("Personal Anthropic API key removed.");
    } else if (value.trim().length > 0) {
      await api.anthropicKeySave(value);
      await alertDialog("Anthropic API key saved to the OS Keychain.");
    }
  } catch (e) {
    await alertDialog("Could not save the key: " + String(e));
  }
}

// Same shape for the DeepSeek key, used by the DeepSeek rows of the model picker.
async function doConfigureDeepSeekKey() {
  const present = await api.deepseekKeyPresent();
  const prompt = present
    ? "DeepSeek API key (currently stored — leave empty to keep, or type a new one to replace; type 'delete' to clear). Used by the DeepSeek models."
    : "Paste your DeepSeek API key from platform.deepseek.com. Used by the DeepSeek models; stored in the OS Keychain, never on disk:";
  const value = await promptText(prompt, "");
  if (value === null) return;
  try {
    if (value.trim().toLowerCase() === "delete") {
      await api.deepseekKeyDelete();
      await alertDialog("DeepSeek API key cleared.");
    } else if (value.trim().length > 0) {
      await api.deepseekKeySave(value);
      await alertDialog("DeepSeek API key saved to the OS Keychain.");
    }
  } catch (e) {
    await alertDialog("Could not save the DeepSeek API key: " + String(e));
  }
}

// Sign out of the LingCode account (LingModel + Cloud deploy share the token).
// If that leaves nothing configured, re-show the onboarding gate so the app
// isn't usable signed out. Mirrors Mac AppDelegate.signOut:.
async function doSignOut() {
  const ok = await confirmDialog(
    "Sign out of LingCode?\n\n" +
    "This signs out of your LingCode account (LingModel). If you also use a " +
    "Claude subscription, sign out of that with `claude logout` in your terminal.",
    "Sign Out",
  );
  if (!ok) return;
  try {
    await api.deployDeleteToken();
  } catch (e) {
    await alertDialog("Couldn't sign out: " + String(e));
    return;
  }
  const [key, ep] = await Promise.all([api.anthropicKeyPresent(), api.endpointGetConfig()]);
  if (!key && !(ep.enabled && ep.key_present)) {
    await showOnboarding(true);   // hard gate — nothing is configured any more
  } else {
    await alertDialog("Signed out of LingCode.");
  }
}

// ---- keyboard (in-webview, complements native menu accelerators) ----
window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveFile(); }
});

// ---- native menu events (the menus still exist; the UI just has homes too) ----
listen<string>("menu", async (ev) => {
  const id = ev.payload;
  if (id.startsWith("model:")) { setModel(id.slice("model:".length)); return; }
  if (id.startsWith("appearance:")) { setAppearance(id.slice("appearance:".length) as Appearance); return; }
  switch (id) {
    case "remote_settings": void openSettings(); break;
    case "invite_helper": void inviteHelper(); break;
    case "open_file": await doOpenFile(); break;
    case "open_folder": await doOpenFolder(); break;
    case "new_quinny_project": await doNewQuinnyProject(); break;
    case "save": await saveFile(); break;
    case "deploy": await runDeploy(folder); break;
    case "custom_endpoint": await showEndpointSheet(); break;
    case "anthropic_key": await doConfigureAnthropicKey(); break;
    case "deepseek_key": await doConfigureDeepSeekKey(); break;
    case "welcome": await showOnboarding(false); break;
    case "find": panel.select("files"); editor.openFind(); break;
    case "find_next": editor.findNext(); break;
    case "find_prev": editor.findPrev(); break;
    case "check_updates": await checkForUpdates(false); break;
    case "stop_claude": chat.abort(); break;
    case "new_conversation": await newChat(); break;
    case "sign_out": await doSignOut(); break;
    case "connect_backend": await connectBackendToFolder(folder); break;
    case "backend_console": await openBackendConsole(); break;
    case "visit_website": await openUrl("https://lingcode.dev").catch(() => {}); break;
    case "thinking:on": chat.setShowThinking(true); break;
    case "thinking:off": chat.setShowThinking(false); break;
    case "sounds:on": chat.playSounds = true; persistPrefs(); break;
    case "sounds:off": chat.playSounds = false; persistPrefs(); break;
  }
}).catch(() => { /* outside Tauri (dev preview) there are no menus */ });

// ---- init ----
applyLayout();
conversations.setProject(null);
(async () => {
  try {
    const prefs = await api.getPrefs();
    setModel(prefs.model, false);
    chat.playSounds = prefs.play_sounds;
    setAppearance((prefs.appearance || "system") as Appearance, false);
  } catch { /* defaults are fine */ }
  updateTitle();
  // First-run onboarding gate — hard gate if nothing is configured yet.
  try { await showOnboardingIfNeeded(); } catch { /* non-fatal */ }
  // Quietly check for updates a few seconds after launch.
  setTimeout(() => checkForUpdates(true), 4000);
  // Dev preview only (VITE_MOCK_TAURI=1): ?folder=<path>&appearance=dark opens
  // the mock project and forces a theme so a headless screenshot has content.
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(location.search);
    const a = q.get("appearance");
    if (a === "light" || a === "dark") setAppearance(a, false);
    const f = q.get("folder");
    if (f) await loadFolder(f);
  }
})();
