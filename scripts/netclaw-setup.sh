#!/usr/bin/env bash
# netclaw-setup.sh — CW-13: fetch NetClaw (read-only use) and build the small
# Python venv its catc-mcp server needs. Prints the two lines for .env.local.
set -euo pipefail
NETCLAW_DIR="${1:-$HOME/netclaw}"
VENV_DIR="${2:-$HOME/netclaw-venv}"
if [ ! -d "$NETCLAW_DIR/.git" ]; then
  git clone --depth 1 https://github.com/automateyournetwork/netclaw "$NETCLAW_DIR"
else
  git -C "$NETCLAW_DIR" pull --ff-only
fi
[ -x "$VENV_DIR/bin/python" ] || python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --quiet --upgrade pip
"$VENV_DIR/bin/python" -m pip install --quiet "mcp>=1.2.0,<2" "httpx>=0.27.0,<1"
echo
echo "Add these two lines to .env.local (then copy config/mcp-servers.example.json to config/mcp-servers.json and set netclaw-catc enabled:true):"
echo "NETCLAW_DIR=$NETCLAW_DIR"
echo "NETCLAW_PYTHON=$VENV_DIR/bin/python"
