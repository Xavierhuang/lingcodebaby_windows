#!/usr/bin/env bash
# Build the PyInstaller-frozen Quinny CLI for Linux and drop it into
# src-tauri/binaries/quinny/, where tauri.conf.json → bundle.resources picks
# it up on the next `cargo tauri build` and ships it inside the .deb / .rpm /
# .AppImage. Sibling of build-quinny-windows.ps1.
#
# Environment overrides (same as the PowerShell script):
#   QUINNY_SOURCE  path to a checkout of the patched Q/ tree. Absent → PyPI.
#   PYTHON         explicit python executable (default `python3`).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/src-tauri/binaries/quinny"
WORK_DIR="$(mktemp -d -t quinny-build.XXXXXX)"
PYTHON="${PYTHON:-python3}"

trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Quinny build (Linux)"
echo "    OutDir : $OUT_DIR"
echo "    WorkDir: $WORK_DIR"

# 1. Fresh venv.
"$PYTHON" -m venv "$WORK_DIR/.venv"
VENV_PY="$WORK_DIR/.venv/bin/python"

# 2. Install pyinstaller + quinny.
"$VENV_PY" -m pip install --upgrade pip pyinstaller
if [ -n "${QUINNY_SOURCE:-}" ]; then
    echo "    installing quinny from source: $QUINNY_SOURCE"
    "$VENV_PY" -m pip install -e "$QUINNY_SOURCE"
else
    echo "    installing quinny from PyPI"
    "$VENV_PY" -m pip install quinny
fi

# 3. Locate installed quinny package + grammar file.
QUINNY_LOC="$("$VENV_PY" -c 'import quinny, pathlib; print(pathlib.Path(quinny.__file__).parent)')"
GRAMMAR="$QUINNY_LOC/grammar.lark"
[ -f "$GRAMMAR" ] || { echo "grammar.lark not found under $QUINNY_LOC" >&2; exit 1; }

# 4. Tiny entry point that calls quinny's CLI main.
cat > "$WORK_DIR/_pyi_entry.py" <<'PY'
from quinny.__main__ import main
if __name__ == "__main__":
    main()
PY

# 5. Freeze onedir. Note: PyInstaller's --add-data uses `:` as the separator
#    on Unix (vs `;` on Windows).
cd "$WORK_DIR"
"$VENV_PY" -m PyInstaller \
    --onedir \
    --name quinny \
    --add-data "$GRAMMAR:quinny" \
    --collect-submodules lark \
    --collect-data lark \
    --collect-submodules anthropic \
    --noconfirm \
    _pyi_entry.py

# 6. Replace the target dir but keep README.md.
if [ -d "$OUT_DIR" ]; then
    find "$OUT_DIR" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
else
    mkdir -p "$OUT_DIR"
fi
cp -R "$WORK_DIR/dist/quinny/." "$OUT_DIR/"

# 7. Sanity check.
EXE="$OUT_DIR/quinny"
[ -x "$EXE" ] || { echo "Freeze completed but $EXE is missing or non-executable" >&2; exit 1; }
echo
echo "==> Done. Frozen Quinny at: $EXE"
echo "    Now run: npm run tauri build"
