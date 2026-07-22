# Bundled Quinny (Windows)

Drop the PyInstaller-frozen `quinny.exe` + the accompanying `_internal/`
onedir here. Everything under this folder is shipped by
`tauri.conf.json → bundle.resources → binaries/quinny/**/*` into
`<app-resources>/binaries/quinny/` at runtime, where `quinny::locate()`
(src-tauri/src/quinny.rs) finds it.

Produced by `scripts/build-quinny-windows.ps1` on a Windows machine.

**Source it must be frozen from:** the same patched Q/ tree Mac freezes from,
not stock `pip install quinny`. The Mac binary depends on two runtime patches
that may not be upstream on PyPI yet:

1. `_capabilities.py::make_client()` sets `default_headers={"User-Agent":
   "quinny/0.1"}` when `ANTHROPIC_AUTH_TOKEN` is set. **Cloudflare's WAF blocks
   the stock `Anthropic/Python …` UA with a 403** ("Your request was blocked.")
   through the LingModel proxy. Without this patch, `quinny gen`/`build`/
   `verify` will fail when routed through LingModel.
2. Credential guards accept `ANTHROPIC_AUTH_TOKEN` (bearer) in addition to
   `ANTHROPIC_API_KEY` (x-api-key), so LingModel routing works without a
   personal Anthropic key.

If a future PyPI release ships both patches, the build script can freeze from
`pip install quinny` directly. Until then, freeze from the maintained Q/
source. See the `lingcodebaby-quinny-bundle` memory for the exact PyInstaller
invocation the Mac uses.

**If this folder is empty at `cargo tauri build` time, the app still builds** —
Quinny is just silently unavailable at runtime:

- `quinny::locate()` returns `None`
- Quinny commands in the UI (context menu, File menu, agent hint) surface a
  "Quinny CLI not found" message
- The bundled-Quinny paragraph is suppressed from the Claude system prompt
  (so the agent isn't told about a CLI it can't reach)

This mirrors the Mac failure mode when `LingCodeBaby/vendor/quinny/` is empty.

The frozen binary is deliberately gitignored — it's ~14 MB and platform-
specific. Producing it belongs in CI, not in the repo.
