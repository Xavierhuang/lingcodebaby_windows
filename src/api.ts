import { invoke, Channel } from "@tauri-apps/api/core";

export interface DirEntry { name: string; path: string; is_dir: boolean; }
export interface Prefs {
  model: string;
  play_sounds: boolean;
  use_custom_endpoint: boolean;
  custom_endpoint_url: string;
  onboarding_complete: boolean;
  appearance: string;
}
export interface EndpointConfig { enabled: boolean; url: string; key_present: boolean; }

/** One rendered transcript row, as persisted. `clean` mirrors the Mac
 *  thinkingOnly flag inverted: clean rows are always shown, the rest only with
 *  View ▸ Show Claude Thinking on. */
export interface StoredMessage { kind: string; text: string; clean: boolean; }
/** `<project>/.lingcode/chat-baby.json`. `session` is the opaque CLI session id
 *  replayed via `claude --resume` so the agent keeps its own context too. */
export interface StoredHistory {
  session: string | null;
  model: string | null;
  messages: StoredMessage[];
  /** Set by the Rust side when the rows came from the legacy shared chat.json;
   *  the session id is deliberately dropped in that case. */
  adopted_legacy?: boolean;
}

export const api = {
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  createFile: (parent: string, name: string) => invoke<string>("create_file", { parent, name }),
  createDir: (parent: string, name: string) => invoke<string>("create_dir", { parent, name }),
  renamePath: (from: string, toName: string) => invoke<string>("rename_path", { from, toName }),
  trashPath: (path: string) => invoke<void>("trash_path", { path }),
  revealInExplorer: (path: string) => invoke<void>("reveal_in_explorer", { path }),
  scaffoldAgentFiles: (folder: string) => invoke<string | null>("scaffold_agent_files", { folder }),

  getPrefs: () => invoke<Prefs>("get_prefs"),
  setPrefs: (prefs: Prefs) => invoke<void>("set_prefs", { prefs }),

  claudeAbort: () => invoke<void>("claude_abort"),

  // Per-project chat transcript + attachments under <project>/.lingcode/.
  historyLoad: (folder: string) => invoke<StoredHistory | null>("history_load", { folder }),
  historySave: (folder: string, doc: StoredHistory) => invoke<void>("history_save", { folder, doc }),
  historyClear: (folder: string) => invoke<void>("history_clear", { folder }),
  attachSave: (folder: string, dataBase64: string, ext: string) =>
    invoke<string>("attach_save", { folder, dataBase64, ext }),
  attachRemove: (path: string) => invoke<void>("attach_remove", { path }),

  // LingCode Cloud managed backend (Postgres + auth + storage + functions).
  cloudConnectBackend: (folder: string) => invoke<void>("cloud_connect_backend", { folder }),
  /** Folder-open auto-wiring. Resolves true only the first time a folder is
   *  wired, so the caller posts the "connected" note once. */
  cloudAutoconnectBackend: (folder: string) => invoke<boolean>("cloud_autoconnect_backend", { folder }),

  // Deploy
  deployApiBase: () => invoke<string>("deploy_api_base"),
  deploySignin: () => invoke<string>("deploy_signin"),
  deployLoadConfig: (folder: string) => invoke<any>("deploy_load_config", { folder }),
  deploySaveConfig: (folder: string, config: any) => invoke<void>("deploy_save_config", { folder, config }),
  deployGetSavedToken: () => invoke<string | null>("deploy_get_saved_token"),
  deploySaveToken: (token: string) => invoke<void>("deploy_save_token", { token }),
  deployDeleteToken: () => invoke<void>("deploy_delete_token"),
  deploySlugify: (input: string) => invoke<string>("deploy_slugify", { input }),
  deployHasIndex: (folder: string) => invoke<boolean>("deploy_has_index", { folder }),
  deployCheck: (token: string, slug: string, exclude: string | null) =>
    invoke<any>("deploy_check", { token, slug, exclude }),

  // Quinny (executable specification language, bundled with the app).
  quinnyAvailable: () => invoke<boolean>("quinny_available"),
  quinnyRun: (subcommand: string, path: string) =>
    invoke<{ exit_code: number; output: string }>("quinny_run", { subcommand, path }),
  quinnyNewFile: (dir: string, name: string) =>
    invoke<string>("quinny_new_file", { dir, name }),
  quinnyNewProject: (folder: string, description: string) =>
    invoke<string>("quinny_new_project", { folder, description }),

  // Personal Anthropic API key (Keychain-backed fallback for signed-out users).
  anthropicKeyPresent: () => invoke<boolean>("anthropic_key_present"),
  anthropicKeySave: (key: string) => invoke<void>("anthropic_key_save", { key }),
  anthropicKeyDelete: () => invoke<void>("anthropic_key_delete"),

  // Custom Anthropic-compatible endpoint (URL + key config sheet).
  endpointGetConfig: () => invoke<EndpointConfig>("endpoint_get_config"),
  endpointSaveConfig: (url: string, key: string, enabled: boolean) =>
    invoke<void>("endpoint_save_config", { url, key, enabled }),
  endpointDisable: () => invoke<void>("endpoint_disable"),
};

// ---- Claude streaming ----
export type ChatEvent =
  | { kind: "session"; id: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "edit"; name: string; input: any }
  | { kind: "ask_user"; question: string; options: string[] }
  | { kind: "result"; text: string; is_error: boolean }
  | { kind: "awaiting" }
  | { kind: "done"; stderr: string };

export function claudeSend(
  args: { message: string; cwd: string; model: string; resume: string | null; attachments: string[] },
  onEvent: (e: ChatEvent) => void
): Promise<void> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("claude_send", { ...args, onEvent: channel });
}

export function deployUpload(
  args: { folder: string; token: string; slug: string | null; title: string; workerId: string | null },
  onEvent: (e: { kind: string; text?: string }) => void
): Promise<{ url: string; workerId: string | null }> {
  const channel = new Channel<{ kind: string; text?: string }>();
  channel.onmessage = onEvent;
  return invoke("deploy_upload", { ...args, onEvent: channel });
}
