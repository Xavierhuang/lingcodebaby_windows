# Releasing LingCodeBaby

How to cut a release: build the installers, sign them for auto-update, publish the
feed. Covers Windows (x64 + arm64), Linux, auto-updates, and code-signing.

## 0. One-time setup

**Updater signing keys** are already generated:
- Public key — committed in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- Private key — `C:\Users\Xavier\.lingcodebaby-updater.key` (password: `<YOUR_KEY_PASSWORD>`).
  **Keep this file + password secret and backed up.** If you lose them, existing
  installs can never auto-update (you'd have to ship a new pubkey + manual download).

Builds read the key from environment variables:
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY      = Get-Content "C:\Users\Xavier\.lingcodebaby-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<YOUR_KEY_PASSWORD>"
```

## 1. Bump the version

Update the version in **all three** files so they match:
- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`
- `src-tauri/tauri.conf.json` → `"version"`

(e.g. `1.0.0` → `1.0.1`). The updater compares this against the feed.

## 2. Build the signed installers

With the signing env vars set (step 0):
```powershell
cd desktop
# x64 — most Windows PCs
npm run tauri build -- --target x86_64-pc-windows-msvc
# arm64 — Windows-on-ARM
npm run tauri build -- --target aarch64-pc-windows-msvc
```
Each produces, under `src-tauri/target/<triple>/release/bundle/nsis/`:
- `LingCodeBaby_<ver>_<arch>-setup.exe`  ← the installer users download
- `LingCodeBaby_<ver>_<arch>-setup.exe.sig`  ← updater signature (from your private key)

> If `.sig` files are missing, the signing env vars weren't set — see step 0.

## 3. Generate the update feed

```powershell
./release/make-manifest.ps1 -Version 1.0.1 -Notes "What changed in this release"
```
Writes `release/latest.json` listing each platform's URL + signature.

## 4. Publish

Upload to `https://lingcode.dev/lingcodebaby/`:
- both `*-setup.exe` installers,
- `latest.json`.

The endpoint URL the app polls is set in `tauri.conf.json` →
`plugins.updater.endpoints`. On next launch, installed apps check it, and
**Check for Updates…** (app menu) triggers it on demand.

## 5. Code signing (optional, removes the SmartScreen warning)

Until the installer is Authenticode-signed, Windows shows "Unknown publisher".
When you have a cert, add a `windows` block under `bundle` in
`src-tauri/tauri.conf.json` (omit it entirely otherwise — an empty thumbprint
still makes the build invoke `signtool` and fail):

```json
"bundle": {
  "windows": {
    "certificateThumbprint": "YOUR_CERT_SHA1_THUMBPRINT",
    "digestAlgorithm": "sha256",
    "timestampUrl": "http://timestamp.digicert.com"
  }
}
```

The cert must be in the Windows certificate store, or use
`"signCommand"` for a custom signer. Then rebuild — no other change needed.
(This is separate from the updater key above.)

## Linux build (run on Linux or WSL — not possible from Windows)

Linux bundles link against `webkit2gtk`, so they must be built on a Linux host.
A helper script installs the deps and builds:
```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.lingcodebaby-updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<YOUR_KEY_PASSWORD>" \
./release/build-linux.sh
```
Produces `.deb`, `.rpm`, and `.AppImage` (+ `.AppImage.sig` for auto-update) under
`src-tauri/target/release/bundle/`. The AppImage is the updater payload for the
`linux-x86_64` platform key.

## CI: build everything at once (recommended)

`.github/workflows/release.yml` builds **Windows (x64 + arm64) and Linux
(deb/rpm/AppImage)** on GitHub-hosted runners and publishes a **draft GitHub
Release** with all installers and a merged `latest.json` (via `tauri-action`'s
`includeUpdaterJson`).

Setup (one-time):
1. Push this project to a GitHub repo (the workflow assumes the repo root holds
   `package.json` + `src-tauri/`; if it's nested, set `projectPath` on the
   tauri-action step).
2. Add repo secrets: `TAURI_SIGNING_PRIVATE_KEY` (contents of the updater key
   file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Release: bump the version (step 1), then push a tag:
```bash
git tag v1.0.1 && git push origin v1.0.1
```
CI builds all targets, attaches them to a draft release, and generates
`latest.json`. Publish the draft. If your updater endpoint stays
`https://lingcode.dev/lingcodebaby/latest.json`, copy the release's `latest.json`
+ installers there (or repoint the endpoint at the GitHub release URLs).
