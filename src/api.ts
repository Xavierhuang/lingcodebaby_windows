import { invoke, Channel } from "@tauri-apps/api/core";

export interface DirEntry { name: string; path: string; is_dir: boolean; }
export interface Prefs {
  model: string;
  play_sounds: boolean;
  use_custom_endpoint: boolean;
  custom_endpoint_url: string;
  onboarding_complete: boolean;
}
export interface EndpointConfig { enabled: boolean; url: string; key_present: boolean; }

/** Whether hands-free voice mode can run right now. Never carries vendor detail. */
export interface VoiceStatus {
  signed_in: boolean;
  transcribe: boolean;
  speak: boolean;
  reason: string;
}
/** Loose speech turned into an agent prompt plus a line to read back aloud. */
export interface VoiceShaped { prompt: string; summary: string; degraded: boolean; }

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

  // Hands-free voice mode. All of these go through Rust because the Tauri CSP
  // pins connect-src to 'self' and ipc: — the webview cannot reach lingcode.dev.
  voiceStatus: () => invoke<VoiceStatus>("voice_status"),
  voiceShape: (text: string) => invoke<VoiceShaped>("voice_shape", { text }),
  voiceTranscribe: (audio: number[], mime: string) =>
    invoke<string>("voice_transcribe", { audio, mime }),
  /** Returns [audio bytes, content type] for the webview to play as a blob. */
  voiceSpeak: (text: string) => invoke<[number[], string]>("voice_speak", { text }),
  /** Answer a spoken risky-tool confirmation. False if the id already timed out. */
  voiceApproveResolve: (id: string, allow: boolean) =>
    invoke<boolean>("voice_approve_resolve", { id, allow }),

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
  args: {
    message: string; cwd: string; model: string; resume: string | null;
    /** True only for hands-free turns — switches Rust to the spoken approval
     *  gate instead of bypassPermissions. Omit for normal hands-on chat. */
    voiceMode?: boolean;
  },
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
