import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// package.json has "type": "module", so `__dirname` isn't defined —
// derive it from import.meta.url for cross-Node-version safety.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Tauri serves the frontend; keep things predictable for the webview.
export default defineConfig({
  clearScreen: false,
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
