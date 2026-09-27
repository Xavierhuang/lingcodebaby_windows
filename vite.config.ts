import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// package.json has "type": "module", so `__dirname` isn't defined —
// derive it from import.meta.url for cross-Node-version safety.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Tauri serves the frontend; keep things predictable for the webview.
// VITE_MOCK_TAURI=1 swaps every Tauri package for src/dev/tauri-mock.ts so the
// UI can be opened in a plain browser and screenshotted. Dev only; a normal
// `npm run build` never sees the alias.
const mock = process.env.VITE_MOCK_TAURI === "1" ? resolve(__dirname, "src/dev/tauri-mock.ts") : null;
const mockAliases = mock
  ? ["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/plugin-dialog",
     "@tauri-apps/plugin-opener", "@tauri-apps/plugin-updater", "@tauri-apps/plugin-process"]
      .map((find) => ({ find, replacement: mock }))
  : [];

export default defineConfig({
  clearScreen: false,
  resolve: { alias: mockAliases },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    // Multi-page: the main window loads index.html, the Help window loads
    // help.html (opened by lib.rs `help_window` menu handler). Both must
    // land in dist/ so Tauri's frontendDist can resolve them via
    // WebviewUrl::App(...).
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        help: resolve(__dirname, "help.html"),
      },
    },
  },
});
