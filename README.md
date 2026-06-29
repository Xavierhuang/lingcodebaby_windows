# LingCodeBaby — Cross-platform (Tauri) edition

A cross-platform rewrite of the original macOS-only `LingCodeMini` (Cocoa/Objective-C)
using **Tauri 2** (Rust backend + web UI). Runs on **Windows**, **macOS**, and **Linux**
from one codebase.

## What it is

A minimal IDE with three panes:

- **File tree** (left) — lazy directory browser with new/rename/delete-to-trash,
  context menu, and reveal-in-file-manager.
- **Code editor** (center) — [CodeMirror 6](https://codemirror.net/) with syntax
  highlighting (Xcode-Light palette), find (Ctrl/Cmd+F), undo/redo, 4-space tabs.
- **Claude chat** (right) — drives the `claude` CLI as a subprocess, streams its
  JSON output, renders thinking/tool steps/file diffs, and shows clickable option
  chips for multiple-choice questions. Model picker + sounds.

Plus **Deploy to LingCode Cloud** — tars the open folder and ships it to the
LingCode Cloudflare Workers API.

## Architecture

| Concern | Original (macOS) | This port |
|---|---|---|
| UI | Cocoa / AppKit | HTML/CSS/TS in a WebView |
| Editor | NSTextView + C syntax engine | CodeMirror 6 |
| File ops | NSFileManager | Rust `std::fs` (`src/fsops.rs`) |
| Claude chat | NSTask | Rust `tokio::process` (`src/chat.rs`) |
| Cloud deploy | NSURLSession + NSTask tar | Rust `reqwest` + `tar`/`flate2` (`src/deploy.rs`) |
| Token storage | Keychain (Security.framework) | `keyring` crate (`src/deploy.rs`) |
| Preferences | NSUserDefaults | JSON in OS config dir (`src/prefs.rs`) |
| Menus | NSMenu | Tauri native menu (`src/lib.rs`) |

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- Platform build tools: **Windows** — VS Build Tools + WebView2 runtime;
  **macOS** — Xcode CLT; **Linux** — webkit2gtk.
- The [`claude` CLI](https://docs.claude.com/claude-code) installed and signed in
  (`claude login`) for the chat panel.

## Develop / run

```bash
cd desktop
npm install
npm run tauri dev      # hot-reload dev build
```

## Build a release installer

```bash
npm run tauri build
```

Outputs (Windows) an NSIS `.exe` installer under
`src-tauri/target/release/bundle/`.

## Cloud sign-in (deploy)

Deploy needs a LingCode Cloud access token (`lcat_…`). The app gets one with a
browser **device-flow** — no copy/paste:

1. Click **Deploy**; if no token is saved you get a "Sign in to LingCode Cloud" dialog.
2. Click **Sign in with LingCode** — the app starts a one-time `localhost` listener
   and opens `…/cli-token.html?session=<uuid>&redirect=http://localhost:<port>`.
3. You sign in (or are already signed in) in the browser; the page mints the token
   (`POST /api/account/cli-token`) and redirects it back to the local listener.
4. The token is stored (OS credential store + the project's `.lingcodedeploy.json`),
   so every later deploy is one-click.

A manual "paste a token" fallback (from `…/cli-token.html`) is offered if the
automatic hand-off can't complete.

## Configuration / environment

- `LINGCODE_API_BASE` — override the cloud API base (default `https://lingcode.dev`).
- `LINGCODE_ACCESS_TOKEN` — cloud token if not stored in the OS credential store.
- The `claude` model and sound toggle persist to `prefs.json` in the OS app-config dir.

## Notes on parity

- The original's portable C syntax engine (`src/syntax/*.c`) is **not** linked;
  CodeMirror provides highlighting. The C engine remains reusable via Rust FFI if
  exact parity is ever needed.
- Token storage on Windows/Linux uses the local credential store, so it is not
  shared with the macOS LingCode app's Keychain entry (that sharing was macOS-only).
