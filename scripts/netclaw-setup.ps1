# netclaw-setup.ps1 — CW-13: fetch NetClaw (read-only use) and build the small
# Python venv its catc-mcp server needs. Run once, from anywhere. Prints the two
# lines to put in .env.local. Never touches credentials.
param(
  [string]$NetclawDir = "$HOME\netclaw",
  [string]$VenvDir    = "$HOME\netclaw-venv"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path "$NetclawDir\.git")) {
  git clone --depth 1 https://github.com/automateyournetwork/netclaw $NetclawDir
} else {
  git -C $NetclawDir pull --ff-only
}
if (-not (Test-Path "$VenvDir\Scripts\python.exe")) {
  py -3.11 -m venv $VenvDir
}
& "$VenvDir\Scripts\python.exe" -m pip install --quiet --upgrade pip
& "$VenvDir\Scripts\python.exe" -m pip install --quiet "mcp>=1.2.0,<2" "httpx>=0.27.0,<1"
Write-Host ""
Write-Host "Add these two lines to .env.local (then copy config\mcp-servers.example.json to config\mcp-servers.json and set netclaw-catc enabled:true):"
Write-Host "NETCLAW_DIR=$NetclawDir"
Write-Host "NETCLAW_PYTHON=$VenvDir\Scripts\python.exe"
