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

**First** freeze the bundled Quinny CLI so `tauri build` picks it up via
`bundle.resources → binaries/quinny/**/*`:
```powershell
pwsh -File scripts\build-quinny-windows.ps1
```
This installs PyInstaller + quinny into a temp venv, freezes an onedir bundle,
and drops `quinny.exe` + `_internal\` into `src-tauri\binaries\quinny\`. Skip it
only if you're intentionally shipping the app without Quinny (locate() returns
None, all Quinny UI surfaces a "not found" alert). Env vars:
- `$env:QUINNY_SOURCE` — path to a checkout of the patched Q/ tree that carries
  the WAF-neutral User-Agent + `ANTHROPIC_AUTH_TOKEN` support. Without it, the
  script `pip install quinny` from PyPI — safe only once those patches ship
  upstream. See `src-tauri/binaries/quinny/README.md` for the full context.
- `$env:PYTHON` — override the python executable (default: `python`).

**Then** build the Tauri installers with the signing env vars from step 0:
```powershell
cd desktop
# x64 — most Windows PCs
npm run tauri build -- --target x86_64-pc-windows-msvc
# arm64 — Windows-on-ARM (reuses the x64 quinny.exe under WoA x64 emulation;
# PyInstaller can't cross-freeze to native arm64 from x64).
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
Freeze the Linux Quinny binary first, then build:
```bash
./scripts/build-quinny-linux.sh
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
3. **Optional:** `QUINNY_SOURCE_REPO` — a git URL of a Quinny fork carrying the
   WAF-neutral User-Agent + `ANTHROPIC_AUTH_TOKEN` patches. When set, CI clones
   it and freezes from there; when empty, CI freezes from stock PyPI (only safe
   once the patches are upstream).

Release: bump the version (step 1), then push a tag:
```bash
git tag v1.0.1 && git push origin v1.0.1
```
CI freezes Quinny natively per platform (Windows x64, Linux x64) into
`src-tauri/binaries/quinny/`, then builds Tauri, attaches all installers to a
draft release, and generates `latest.json`. Windows arm64 reuses the x64
`quinny.exe` (WoA runs it under x64 emulation). Publish the draft. If your
updater endpoint stays `https://lingcode.dev/lingcodebaby/latest.json`, copy
the release's `latest.json` + installers there (or repoint the endpoint at the
GitHub release URLs).
