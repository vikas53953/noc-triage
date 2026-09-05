#!/usr/bin/env bash
# netclaw-setup.sh — CW-13: fetch NetClaw (read-only use) and build the small
# Python venv its catc-mcp server needs. Prints the two lines for .env.local.
set -euo pipefail
NETCLAW_DIR="${1:-$HOME/netclaw}"
VENV_DIR="${2:-$HOME/netclaw-venv}"
# PINNED to the commit the vetting record (config/mcp-servers.example.json,
# docs/copilot-cw13-netclaw-contract.md) was written against. Moving it means
# re-vetting; the connector refuses the record on a changed server.py anyway.
NETCLAW_PIN="${NETCLAW_PIN:-c703a8fe292a87a6a55a0b7ea9438d89a7ec5aa6}"
if [ ! -d "$NETCLAW_DIR/.git" ]; then
  git -c core.autocrlf=false clone --no-checkout https://github.com/automateyournetwork/netclaw "$NETCLAW_DIR"
  git -C "$NETCLAW_DIR" config core.autocrlf false
fi
git -C "$NETCLAW_DIR" fetch --quiet origin "$NETCLAW_PIN" || git -C "$NETCLAW_DIR" fetch --quiet origin
git -C "$NETCLAW_DIR" -c core.autocrlf=false checkout --quiet "$NETCLAW_PIN"
[ -x "$VENV_DIR/bin/python" ] || python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --quiet --upgrade pip
"$VENV_DIR/bin/python" -m pip install --quiet "mcp>=1.2.0,<2" "httpx>=0.27.0,<1"
echo
echo "Add these two lines to .env.local (then copy config/mcp-servers.example.json to config/mcp-servers.json and set netclaw-catc enabled:true):"
echo "NETCLAW_DIR=$NETCLAW_DIR"
echo "NETCLAW_PYTHON=$VENV_DIR/bin/python"
