# Bundled Claude Code CLI (Windows)

`claude.exe` here is shipped by `tauri.conf.json → bundle.resources →
binaries/claude/**/*` into `<app-resources>/binaries/claude/` at runtime, where
`claude_bin::bundled_exe()` (src-tauri/src/claude_bin.rs) finds it and
`chat::find_claude_with()` prefers it over any Claude Code installed on the
machine. That is what lets a fresh Windows install chat without downloading
Claude Code first.

Produced by `scripts/fetch-claude-windows.ps1 -Arch x64|arm64`, which pulls
Anthropic's npm platform package `@anthropic-ai/claude-agent-sdk-win32-<arch>`
at the version pinned by `CLAUDE_SDK_VERSION` in `.github/workflows/release.yml`
(the same package family the Mac LingCode app bundles). The x64 and arm64
release jobs each fetch their own architecture, so Windows-on-ARM runs native.

Never commit the binary: everything but this README is gitignored. To ship a
newer CLI, bump `CLAUDE_SDK_VERSION` and cut a release. The bundled copy runs
with `DISABLE_AUTOUPDATER=1` because it cannot rewrite itself inside the
install directory.
