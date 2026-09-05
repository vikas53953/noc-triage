# CW-13 — NetClaw as the first real external MCP server — CONTRACT + VETTING RECORD (2026-09-05)

Vikas's ask, HIS WORDS (2026-09-05): "on the MCP server, there is one repo. I really want you to plug in
that repo as an MCP because that plugin is really good … https://github.com/automateyournetwork/netclaw
… this is open source again, so we can leverage this repo behind the scenes rather than building it
ourselves. Since we are building this product from scratch, I really want you to leverage multiple
frameworks … there is no point in building each and every thing."

Laws that govern this wave: **7 (adopt, don't hand-write, integrations — security-vetted MCP servers
through the CW-8 connector)**, 3 (never fabricate), 4 (permission gate: deny = zero wire), 5 (secrets
never persist). New law 9 (adopt frameworks) is the same instinct one layer up.

## What NetClaw is (read-only survey of the public repo, commit c703a8f, Apache-2.0)

A large open-source "network agent" project. Its value to us is not its Python agent runtime — it is the
**~54 vendored MCP servers** under `mcp-servers/` (Catalyst Center, ACI, SD-WAN, ISE, Meraki, F5,
Check Point, Fortinet, syslog/SNMP/IPFIX receivers, Batfish, Nautobot, NVD, pyATS …). Each is a separate
stdio program speaking the Model Context Protocol; the CW-8 connector (sources/mcp-client.js +
sources/mcp-connector.js) already speaks that protocol. `docs/netclaw-assessment.md` (2026-08-19) ranked
them value × ease; this wave wires the first one.

## The first server: `mcp-servers/catc-mcp` (Catalyst Center, read-only)

Why first: it reads the SAME appliance our own `sources/catalyst-center.js` reads (the DevNet always-on
sandbox Vikas already has credentials for), and it turns ~6 hand-coded calls into **all 514 read-only
operations** behind 10 tools (`catc_find` local search → `catc_describe_operation` → `catc_<group>`).

### Vetting record — what was actually read, and what it does

| Question | Finding (from `server.py`, 13,969 bytes, read in full; `requirements.txt`; `README.md`; `NOTICE.md`) |
|---|---|
| Can it write to the appliance? | **No.** Only GET operations are catalogued; the single POST in Cisco's upstream bundle (`api_complianceRemediation`) is absent from the catalogue, so it cannot be dispatched. Read-only by construction, not by a runtime flag. |
| Network egress | One host only: `CATALYST_CENTER_HOST` (token endpoint `/dna/system/api/v1/auth/token`, then GETs). `catc_find` and `catc_describe_operation` never touch the network. |
| TLS | Verified by default (`CATALYST_CENTER_VERIFY_SSL` defaults to `true`); a disabled verify is stamped as a caveat on every response. |
| Credentials | Read from env (`CATALYST_CENTER_USERNAME/PASSWORD/HOST`); token cached in process memory only; never logged, never written. |
| Files / processes / shell | Reads its own `catalog/*.json` only. No file writes, no `subprocess`, no `os.system`, no `eval`. |
| Dependencies | `mcp>=1.2.0,<2` and `httpx>=0.27,<1` — two packages, pinned. Deliberately NOT the upstream server's `fastmcp` / `uvicorn` set. |
| Honesty design | Every response passes one `_envelope()` chokepoint carrying `appliance`, `observed_at`, a typed `outcome` (ok · empty · unreachable · auth_failed · forbidden · not_configured · refused · error) and caveats; an empty list or a zero count is flagged "NOT an empty network". This is our own law 3 written by someone else. |
| Provenance | Cisco's official generated tool catalogue (`cisco-en-programmability/catc-mcp-oss`, Apache-2.0, release/2.3.7.11) + NetClaw's thin client. See NetClaw `NOTICE.md`. |
| NetClaw's own scan | `DefenseClawMCPScan.md` in the repo lists 42 scanned directories as CLEAN; `catc-mcp` is newer than that scan and is not in its list — so the read above is OUR vetting, not theirs. |
| MCP annotations | **None** (FastMCP `@mcp.tool()` without annotations → `annotations: null`). This is the one thing the connector could not accept as-is — see the seam below. |

Residual risks, stated plainly: the server is Python run as a child process of our Node server (a venv per
machine; `mcp<2` is load-bearing — 2.0 removed `mcp.server.fastmcp`); large GET responses are returned
whole and our connector clips tool text at 4,000 characters (honest truncation, not a fabrication);
"read-only" also depends on using a **least-privilege account** on the appliance — the DevNet sandbox
account is shared and read-only in practice.

## The seam (what CW-13 adds to the connector — additive, all optional)

| Config key | Meaning | Safety |
|---|---|---|
| `"${VAR}"` in `command` / `args` / `cwd` | expanded from the server's own environment (`.env.local`) | one committed example config works on every machine; an unset var stays visibly unexpanded |
| `envFrom: { CHILD: "PARENT" }` | the child gets `PARENT`'s value from our process env under the name `CHILD` | no credential value is ever written in the config file; an unset parent var is not passed and is reported in status by NAME only |
| `vettedReadOnly: { by, date, why }` | the operator's record that this server is read-only by construction | honoured only with `by` AND `why`; a tool that DECLARES itself a write stays a write; every call still passes the permission gate (deny = zero wire) and the audit |

Pinned by `sources/mcp.cw13.test.js` on a no-annotation stub (`test/mcp-noannot-server.js`) and, when a
NetClaw checkout + Python are present, LIVE on the real `catc-mcp` (10 tools, a real local catalogue
search, an honest `not_configured`/`refused` with no appliance). The CW-8 suite is unchanged and green.

## Setting it up on Vikas's PC (Windows)

```powershell
# 1. clone NetClaw next to noc-triage (read-only use; we never modify it)
git clone https://github.com/automateyournetwork/netclaw C:\Users\vikasmit\netclaw
# 2. a Python venv with the two deps (Python 3.11+)
py -3.11 -m venv C:\Users\vikasmit\netclaw-venv
C:\Users\vikasmit\netclaw-venv\Scripts\pip install "mcp>=1.2.0,<2" "httpx>=0.27.0,<1"
# 3. point noc-triage at it — .env.local
NETCLAW_DIR=C:\Users\vikasmit\netclaw
NETCLAW_PYTHON=C:\Users\vikasmit\netclaw-venv\Scripts\python.exe
# 4. enable the server: copy config/mcp-servers.example.json to config/mcp-servers.json
#    and set "enabled": true on netclaw-catc (DNAC_* in .env.local feed it via envFrom)
# 5. restart :3000 → Capabilities panel → "External tools" shows netclaw-catc · 10 tools
```
`scripts/netclaw-setup.ps1` does steps 1–3. On Linux/macOS: `scripts/netclaw-setup.sh`.

## What "done" looks like for CW-13 (live, on the PC)
- `GET /api/copilot/mcp/status` → `netclaw-catc` connected, `toolCount: 10`, `vettedReadOnly` shown, `envMissing` empty.
- Ask Jarvis "what does Catalyst Center say about sw1's compliance?" → the planner delegates to
  `mcp:netclaw-catc:catc_find` then a `catc_<group>` read; the finding shows the real envelope
  (`appliance`, `observed_at`, `outcome`), and an empty result is narrated as "the controller returned
  none", never "the network has none".
- Deny mode → zero calls (audit shows `denied`).

## Not in this wave
Other NetClaw servers (ACI, SD-WAN, ISE, syslog/SNMP/IPFIX receivers …) — each gets its own vetting
record and config entry when Vikas picks it; the seam above is reused unchanged. Streaming/HTTP MCP
transports (the connector is stdio-only). Replacing our own `catalyst-center.js` reads — they stay; the
planner now has both and chooses by intent.
