# Fetch the Claude Code CLI for Windows and drop it into src-tauri/binaries/claude/,
# where tauri.conf.json → bundle.resources ships it inside the NSIS installer and
# chat.rs prefers it over any Claude Code the user installed themselves.
#
# Source: Anthropic's npm platform package, the same family the Mac LingCode app
# bundles (`@anthropic-ai/claude-agent-sdk-darwin-arm64`). Each package holds one
# file, `claude.exe`, the full CLI for that architecture. Runs in CI
# (see .github/workflows/release.yml) and on a dev machine with npm on PATH.
#
# Usage:
#   pwsh -File scripts/fetch-claude-windows.ps1 -Arch x64
#   pwsh -File scripts/fetch-claude-windows.ps1 -Arch arm64
#
# Environment:
#   $env:CLAUDE_SDK_VERSION  package version to fetch (default below; the
#                            workflow pins it). Bump it to ship a newer CLI.
param(
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"

$Version = if ($env:CLAUDE_SDK_VERSION) { $env:CLAUDE_SDK_VERSION } else { "0.3.282" }
$Package = "@anthropic-ai/claude-agent-sdk-win32-$Arch"
$Root    = Split-Path -Parent $PSScriptRoot
$OutDir  = Join-Path $Root "src-tauri\binaries\claude"
$WorkDir = Join-Path $env:TEMP "claude-fetch-$([Guid]::NewGuid().ToString('N').Substring(0,8))"

Write-Host "==> Claude Code fetch (Windows $Arch)"
Write-Host "    Package: $Package@$Version"
Write-Host "    OutDir : $OutDir"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir  | Out-Null
Push-Location $WorkDir
try {
    # `npm pack` downloads the registry tarball without installing anything.
    $tgz = (& npm pack "$Package@$Version" --silent 2>&1 | Select-Object -Last 1).ToString().Trim()
    if (-not (Test-Path $tgz)) { throw "npm pack did not produce a tarball (got '$tgz')" }
    # Windows 10+ ships bsdtar as tar.exe.
    & tar -xzf $tgz
    $exe = Join-Path $WorkDir "package\claude.exe"
    if (-not (Test-Path $exe)) { throw "claude.exe missing from $Package@$Version" }
    $bytes = (Get-Item $exe).Length
    if ($bytes -lt 50MB) { throw "claude.exe is only $bytes bytes; refusing to ship a stub" }

    # Replace whatever was there so a version bump never leaves a stale binary.
    Get-ChildItem $OutDir -Exclude README.md | Remove-Item -Recurse -Force
    Copy-Item $exe (Join-Path $OutDir "claude.exe")
    Copy-Item (Join-Path $WorkDir "package\LICENSE.md") (Join-Path $OutDir "LICENSE.md") -ErrorAction SilentlyContinue
    Set-Content -Path (Join-Path $OutDir "VERSION") -Value "$Package@$Version"
    Write-Host ("    claude.exe: {0:N0} bytes" -f $bytes)
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
}
Write-Host "==> done"
