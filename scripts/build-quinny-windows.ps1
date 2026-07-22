# Build the PyInstaller-frozen Quinny CLI for Windows and drop it into
# src-tauri/binaries/quinny/, where tauri.conf.json → bundle.resources picks
# it up on the next `cargo tauri build` and ships it inside the NSIS installer.
#
# Mirrors what the Mac Makefile does with `vendor/quinny/`: freeze once per
# Quinny release, then rebuild the app. Runs on both dev machines and in CI
# (see .github/workflows/release.yml).
#
# Usage:
#   pwsh -File scripts/build-quinny-windows.ps1
#
# Environment overrides:
#   $env:QUINNY_SOURCE  = path to a checkout of the patched Q/ tree with the
#                         WAF-neutral User-Agent + ANTHROPIC_AUTH_TOKEN patches
#                         (see src-tauri/binaries/quinny/README.md). Absent →
#                         `pip install quinny` from PyPI (may lack patches;
#                         only safe if the LingModel WAF issue is fixed
#                         upstream).
#   $env:PYTHON         = explicit python executable to use (default `python`).

$ErrorActionPreference = "Stop"

$Root       = Split-Path -Parent $PSScriptRoot
$OutDir     = Join-Path $Root "src-tauri\binaries\quinny"
$WorkDir    = Join-Path $env:TEMP "quinny-build-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$Python     = if ($env:PYTHON) { $env:PYTHON } else { "python" }

Write-Host "==> Quinny build (Windows)"
Write-Host "    OutDir : $OutDir"
Write-Host "    WorkDir: $WorkDir"

# 1. Fresh venv so PyInstaller doesn't pick up unrelated packages from the host.
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
& $Python -m venv (Join-Path $WorkDir ".venv")
if ($LASTEXITCODE -ne 0) { throw "Failed to create venv (is Python 3.10+ on PATH?)" }
$VenvPython = Join-Path $WorkDir ".venv\Scripts\python.exe"

# 2. Install pyinstaller + quinny (either the patched source or PyPI).
& $VenvPython -m pip install --upgrade pip pyinstaller
if ($env:QUINNY_SOURCE) {
    Write-Host "    installing quinny from source: $env:QUINNY_SOURCE"
    & $VenvPython -m pip install -e $env:QUINNY_SOURCE
} else {
    Write-Host "    installing quinny from PyPI"
    & $VenvPython -m pip install quinny
}
if ($LASTEXITCODE -ne 0) { throw "Failed to install quinny" }

# 3. Locate the installed `quinny` package so we can copy its grammar into the
#    freeze. PyInstaller can't discover Lark grammar files on its own — the
#    Mac freeze passes them explicitly via --add-data.
$QuinnyLoc = & $VenvPython -c "import quinny, pathlib; print(pathlib.Path(quinny.__file__).parent)"
if ($LASTEXITCODE -ne 0) { throw "Could not locate installed quinny package" }
$Grammar   = Join-Path $QuinnyLoc "grammar.lark"
if (-not (Test-Path $Grammar)) {
    throw "grammar.lark not found under $QuinnyLoc — is this a supported Quinny version?"
}

# 4. Write a tiny PyInstaller entry point that just calls quinny's CLI main.
$Entry = Join-Path $WorkDir "_pyi_entry.py"
@"
from quinny.__main__ import main
if __name__ == "__main__":
    main()
"@ | Set-Content -Path $Entry -Encoding utf8

# 5. Freeze — --onedir (not --onefile) so startup is fast and Sparkle-style
#    delta updates stay small. Matches the Mac freeze recipe.
Push-Location $WorkDir
try {
    & $VenvPython -m PyInstaller `
        --onedir `
        --name quinny `
        --add-data "$Grammar;quinny" `
        --collect-submodules lark `
        --collect-data lark `
        --collect-submodules anthropic `
        --noconfirm `
        $Entry
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller freeze failed" }
} finally {
    Pop-Location
}

# 6. Replace the target dir atomically-ish (rm → cp) so a botched freeze
#    doesn't leave a half-populated bundle.
if (Test-Path $OutDir) {
    # Keep the README the port added; delete everything else.
    Get-ChildItem $OutDir -Force |
        Where-Object { $_.Name -ne "README.md" } |
        ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
} else {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}
$FrozenDist = Join-Path $WorkDir "dist\quinny"
Copy-Item -Path (Join-Path $FrozenDist "*") -Destination $OutDir -Recurse -Force

# 7. Sanity check.
$Exe = Join-Path $OutDir "quinny.exe"
if (-not (Test-Path $Exe)) {
    throw "Freeze completed but $Exe is missing — inspect $FrozenDist"
}
Write-Host ""
Write-Host "==> Done. Frozen Quinny at: $Exe"
Write-Host "    Now run: npm run tauri build"

# 8. Best-effort cleanup — the tempdir is huge (~200 MB).
Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
