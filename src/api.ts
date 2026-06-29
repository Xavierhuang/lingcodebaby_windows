import { invoke, Channel } from "@tauri-apps/api/core";

export interface DirEntry { name: string; path: string; is_dir: boolean; }
export interface Prefs { model: string; play_sounds: boolean; }

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

  // Deploy
  deployApiBase: () => invoke<string>("deploy_api_base"),
  deploySignin: () => invoke<string>("deploy_signin"),
  deployLoadConfig: (folder: string) => invoke<any>("deploy_load_config", { folder }),
  deploySaveConfig: (folder: string, config: any) => invoke<void>("deploy_save_config", { folder, config }),
  deployGetSavedToken: () => invoke<string | null>("deploy_get_saved_token"),
  deploySaveToken: (token: string) => invoke<void>("deploy_save_token", { token }),
  deploySlugify: (input: string) => invoke<string>("deploy_slugify", { input }),
  deployHasIndex: (folder: string) => invoke<boolean>("deploy_has_index", { folder }),
  deployCheck: (token: string, slug: string, exclude: string | null) =>
    invoke<any>("deploy_check", { token, slug, exclude }),
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
  args: { message: string; cwd: string; model: string; resume: string | null },
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
