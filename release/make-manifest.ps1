# Generates the updater feed (latest.json) from the built+signed installers.
# Run AFTER `npm run tauri build` (with signing env vars set) for each arch.
#
#   ./release/make-manifest.ps1 -Version 1.0.1 -Notes "Bug fixes"
#
# Then upload the *-setup.exe files AND latest.json to:
#   https://lingcode.dev/lingcodebaby/

param(
  [string]$Version = "1.0.0",
  [string]$Notes   = "",
  [string]$PubDate = ""    # ISO-8601; defaults to now (UTC)
)
$ErrorActionPreference = "Stop"
if (-not $PubDate) { $PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

$root    = Split-Path $PSScriptRoot -Parent      # desktop/
$baseUrl = "https://lingcode.dev/lingcodebaby"

function Read-Sig($exe) {
  if (Test-Path "$exe.sig") { return (Get-Content "$exe.sig" -Raw).Trim() }
  Write-Warning "No signature for $exe - build with TAURI_SIGNING_PRIVATE_KEY set."
  return $null
}

# Map updater platform key -> built installer path for this version.
# Windows only here; Linux is built in CI (the GitHub Actions workflow generates
# and merges latest.json automatically via tauri-action's includeUpdaterJson).
$targets = [ordered]@{
  "windows-x86_64"  = "$root\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\LingCodeBaby_${Version}_x64-setup.exe"
  "windows-aarch64" = "$root\src-tauri\target\release\bundle\nsis\LingCodeBaby_${Version}_arm64-setup.exe"
}

$platforms = [ordered]@{}
foreach ($key in $targets.Keys) {
  $path = $targets[$key]
  if (Test-Path $path) {
    $sig = Read-Sig $path
    if ($sig) {
      $platforms[$key] = [ordered]@{ signature = $sig; url = "$baseUrl/$(Split-Path $path -Leaf)" }
      Write-Host ("  + {0} -> {1}" -f $key, (Split-Path $path -Leaf))
    }
  }
}

if ($platforms.Count -eq 0) { throw "No signed installers found for version $Version. Build first." }

$manifest = [ordered]@{ version = $Version; notes = $Notes; pub_date = $PubDate; platforms = $platforms }
$outPath  = Join-Path $PSScriptRoot "latest.json"
# Write UTF-8 WITHOUT a BOM — a BOM breaks JSON.parse (e.g. in tauri-action's
# updater-manifest merge), which silently drops platforms from latest.json.
$json = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("Wrote {0}  (version {1}, {2} platform(s))" -f $outPath, $Version, $platforms.Count)
