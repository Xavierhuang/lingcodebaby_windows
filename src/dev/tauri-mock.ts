// Dev-only stand-in for the Tauri bridge so the front end can be opened in a
// plain browser (VITE_MOCK_TAURI=1 npm run dev) and screenshotted. An
// in-memory folder with an index.html, canned prefs and a scripted chat turn.
// Never bundled: vite.config.ts only aliases the Tauri packages here in dev.

const FOLDER = "C:/Users/dev/Projects/lingcut";
const files = new Map<string, string>([
  [`${FOLDER}/index.html`, "<!doctype html><html><body style='font-family:system-ui;padding:24px'><h1>lingcut</h1><p>Hello from the preview.</p></body></html>"],
  [`${FOLDER}/style.css`, "body { color: #333; }"],
  [`${FOLDER}/app.js`, "console.log('hi');"],
]);
const dirs = new Set<string>([FOLDER, `${FOLDER}/assets`]);
let prefs = { model: "lingmodel", play_sounds: true, use_custom_endpoint: false, custom_endpoint_url: "", onboarding_complete: true, appearance: "system" };

function listDir(path: string) {
  const out: Array<{ name: string; path: string; is_dir: boolean }> = [];
  for (const d of dirs) if (d !== path && d.startsWith(path + "/") && !d.slice(path.length + 1).includes("/")) out.push({ name: d.split("/").pop()!, path: d, is_dir: true });
  for (const f of files.keys()) if (f.startsWith(path + "/") && !f.slice(path.length + 1).includes("/")) out.push({ name: f.split("/").pop()!, path: f, is_dir: false });
  return out.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
}

export class Channel<T> { onmessage: (m: T) => void = () => {}; }

export async function invoke<T>(cmd: string, args: any = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 15));
  const a = args as any;
  switch (cmd) {
    case "get_prefs": return prefs as T;
    case "set_prefs": prefs = a.prefs; return undefined as T;
    case "list_dir": if (!dirs.has(a.path)) throw new Error("no such dir"); return listDir(a.path) as T;
    case "read_text_file": { const v = files.get(a.path); if (v === undefined) throw new Error("no such file"); return v as T; }
    case "write_text_file": files.set(a.path, a.contents); { const d = a.path.slice(0, a.path.lastIndexOf("/")); dirs.add(d); } return undefined as T;
    case "create_dir": { const p = `${a.parent}/${a.name}`; if (dirs.has(p)) throw new Error("exists"); dirs.add(p); return p as T; }
    case "create_file": { const p = `${a.parent}/${a.name}`; files.set(p, ""); return p as T; }
    case "trash_path": files.delete(a.path); dirs.delete(a.path); return undefined as T;
    case "deploy_has_index": return files.has(`${a.folder}/index.html`) as T;
    case "history_load": return ({ session: "legacy-sess", model: "lingmodel", messages: [
      { kind: "user", text: "Make the hero say hello", clean: true },
      { kind: "tool", text: "🔧 Read index.html", clean: false },
      { kind: "edit", text: "✏️ Edit index.html\n- <h1>lingcut</h1>\n+ <h1>Hello</h1>", clean: true },
      { kind: "assistant", text: "Done — the hero now says Hello.", clean: true },
    ] }) as T;
    case "cloud_autoconnect_backend": return false as T;
    case "scaffold_agent_files": return null as T;
    case "anthropic_key_present": case "deepseek_key_present": return false as T;
    case "endpoint_get_config": return ({ enabled: false, url: "", key_present: false }) as T;
    case "claude_abort": return undefined as T;
    case "claude_send": {
      const ch = a.onEvent as Channel<any>;
      const say = (m: any, ms: number) => setTimeout(() => ch.onmessage(m), ms);
      say({ kind: "session", id: "mock-sess" }, 50);
      say({ kind: "tool", name: "Read", detail: "index.html" }, 300);
      say({ kind: "edit", name: "Edit", input: { file_path: `${FOLDER}/index.html`, old_string: "<p>Hello from the preview.</p>", new_string: "<p>Hello, world.</p>" } }, 700);
      say({ kind: "result", text: "I changed the paragraph to say Hello, world.", is_error: false }, 1100);
      say({ kind: "done", stderr: "" }, 1200);
      await new Promise((r) => setTimeout(r, 1300));
      files.set(`${FOLDER}/index.html`, files.get(`${FOLDER}/index.html`)!.replace("Hello from the preview.", "Hello, world."));
      return undefined as T;
    }
    default: throw new Error(`mock: unhandled command ${cmd}`);
  }
}

export function convertFileSrc(path: string): string {
  // Serve the in-memory index.html as a blob so the iframe has something to show.
  const html = files.get(path) || "<p>missing</p>";
  return URL.createObjectURL(new Blob([html], { type: "text/html" }));
}

export async function listen<T>(_name: string, _cb: (ev: { payload: T }) => void): Promise<() => void> { return () => {}; }
export const UserAttentionType = { Informational: 2 } as const;
export function getCurrentWindow() {
  return { setTitle: async (_t: string) => {}, isFocused: async () => true, requestUserAttention: async (_k: number) => {} };
}
export async function open(opts: any): Promise<string | null> {
  return opts && opts.directory ? FOLDER : `${FOLDER}/index.html`;
}
export async function openUrl(url: string) { window.open(url, "_blank"); }
export async function check() { return null; }
export async function relaunch() {}
