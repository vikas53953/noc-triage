# netclaw-setup.ps1 — CW-13: fetch NetClaw (read-only use) and build the small
# Python venv its catc-mcp server needs. Run once, from anywhere. Prints the two
# lines to put in .env.local. Never touches credentials.
param(
  [string]$NetclawDir = "$HOME\netclaw",
  [string]$VenvDir    = "$HOME\netclaw-venv"
)
$ErrorActionPreference = "Stop"
# PINNED to the commit the vetting record was written against (see
# config/mcp-servers.example.json). Moving it means re-vetting; the connector
# refuses the record on a changed server.py anyway.
$NetclawPin = if ($env:NETCLAW_PIN) { $env:NETCLAW_PIN } else { "c703a8fe292a87a6a55a0b7ea9438d89a7ec5aa6" }
if (-not (Test-Path "$NetclawDir\.git")) {
  git -c core.autocrlf=false clone --no-checkout https://github.com/automateyournetwork/netclaw $NetclawDir
  git -C $NetclawDir config core.autocrlf false
}
git -C $NetclawDir fetch --quiet origin $NetclawPin 2>$null; if ($LASTEXITCODE -ne 0) { git -C $NetclawDir fetch --quiet origin }
git -C $NetclawDir -c core.autocrlf=false checkout --quiet $NetclawPin
if (-not (Test-Path "$VenvDir\Scripts\python.exe")) {
  py -3.11 -m venv $VenvDir
}
& "$VenvDir\Scripts\python.exe" -m pip install --quiet --upgrade pip
& "$VenvDir\Scripts\python.exe" -m pip install --quiet "mcp>=1.2.0,<2" "httpx>=0.27.0,<1"
Write-Host ""
Write-Host "Add these two lines to .env.local (then copy config\mcp-servers.example.json to config\mcp-servers.json and set netclaw-catc enabled:true):"
Write-Host "NETCLAW_DIR=$NetclawDir"
Write-Host "NETCLAW_PYTHON=$VenvDir\Scripts\python.exe"
