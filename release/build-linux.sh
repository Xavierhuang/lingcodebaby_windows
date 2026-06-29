#!/usr/bin/env bash
# Build the Linux bundles (.deb / .rpm / AppImage) for LingCodeBaby.
# Run on a Linux host or under WSL (Ubuntu/Debian). Not possible from Windows.
#
#   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.lingcodebaby-updater.key)" \
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<YOUR_KEY_PASSWORD>" \
#   ./release/build-linux.sh
set -euo pipefail

# 1. System dependencies (Debian/Ubuntu).
if command -v apt-get >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
    build-essential libssl-dev libgtk-3-dev libayatana-appindicator3-dev curl
fi

# 2. Toolchains (skip if already installed).
command -v cargo >/dev/null || curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
command -v node  >/dev/null || { echo "Install Node 18+ first"; exit 1; }

# 3. Build. The signing env vars produce the .AppImage.sig used by the updater.
cd "$(dirname "$0")/.."
npm ci
npm run tauri build

echo
echo "Bundles written under src-tauri/target/release/bundle/ :"
ls -1 src-tauri/target/release/bundle/deb/*.deb \
      src-tauri/target/release/bundle/rpm/*.rpm \
      src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null || true
