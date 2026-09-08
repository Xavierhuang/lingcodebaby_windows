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
    # NOT `pip install -e`. An editable install leaves only a __editable__
    # finder shim in site-packages, which PyInstaller's static analysis cannot
    # follow — it then collects ZERO quinny modules and reports no error.
    # The `--add-data "$Grammar;quinny"` below still creates a quinny\ directory
    # in the bundle, so at runtime `quinny` resolves as a namespace package and
    # the import dies one level down with:
    #     ModuleNotFoundError: No module named 'quinny.__main__'
    # That shipped to Windows users. Reproduced and fixed 2026-09-07: a plain
    # (non-editable) install of the same source freezes correctly.
    & $VenvPython -m pip install $env:QUINNY_SOURCE
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

# 7. Sanity check — RUN the binary, don't just look at it.
#
# This used to be `Test-Path $Exe` only. A frozen bundle that cannot import its
# own entry module still produces an .exe, so the build reported success and
# shipped a Quinny that died on first launch with a PyInstaller traceback.
# Existence is not function: start it and require a zero exit.
$Exe = Join-Path $OutDir "quinny.exe"
if (-not (Test-Path $Exe)) {
    throw "Freeze completed but $Exe is missing — inspect $FrozenDist"
}

Write-Host "    smoke: $Exe --help"
# $ErrorActionPreference is "Stop" for this script; with `2>&1` a native
# command's stderr becomes error records and would throw here BEFORE the
# exit-code check, hiding the traceback we actually want to print. Relax it
# just for this call.
$PrevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$SmokeOut = & $Exe --help 2>&1
$SmokeExit = $LASTEXITCODE
$ErrorActionPreference = $PrevEAP
if ($SmokeExit -ne 0) {
    Write-Host ""
    Write-Host "Freeze produced a binary that FAILS TO RUN:" -ForegroundColor Red
    Write-Host ($SmokeOut | Out-String)
    Write-Host "If this is 'No module named quinny.__main__', the quinny install"
    Write-Host "was editable (pip install -e) and PyInstaller collected none of it."
    throw "Quinny smoke test failed"
}

Write-Host ""
Write-Host "==> Done. Frozen Quinny at: $Exe (smoke-tested)"
Write-Host "    Now run: npm run tauri build"

# 8. Best-effort cleanup — the tempdir is huge (~200 MB).
Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
