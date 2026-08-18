# NetClaw — what noc-triage can actually pull from it

*Survey date: 2026-08-19. Read-only look at the external NetClaw repo (Apache-2.0, ~2400 files,
mostly Python + Markdown + MCP servers). Nothing in either repo was changed.*

## The one thing to understand first

NetClaw's real value to us is **not its Python brain** — that's a different, much bigger animal
(their agent runs on "OpenClaw", 222 skills, its own token accounting, federation, certificates).
Their value to us is the **~40 network tools they ship as MCP servers** (plus ~60 more they document
as installable). Each MCP server is a **separate little program** with a standard plug (the "Model
Context Protocol"). Anything that speaks that plug can call them — including a Node app like ours.

**But our Jarvis cannot speak that plug today.** Our `package.json` has express, ws, chokidar, cors —
and no MCP client. So every "directly reusable" item below has the **same single prerequisite: give
Jarvis an MCP client first.** That's one focused piece of plumbing (an official
`@modelcontextprotocol/sdk` client that launches a server as a child process, lists its tools, and
lets Jarvis call them as delegated reads). Build that once, and a dozen of their servers become
tools Jarvis can reach — without us porting any Python.

Everything is ranked **value × ease** for *noc-triage specifically*.

---

## BUCKET A — Directly reusable (drop-in or near)

> Reminder: "drop-in" here means "run their server as an external tool" — **after** we add the MCP
> client. None of these require porting their Python into our Node.

### A1. The MCP-client bridge itself — **HIGH** (the unlock)
- **What:** a small Node module in Jarvis that speaks MCP over stdio: spawn a server, read its tool
  list, call a tool, get JSON back. Register those tools in the same delegation roster Jarvis already
  uses for our own agents.
- **Why for us:** it's the gate to A2–A8. Without it none of their servers are reachable; with it,
  each one is a new Jarvis capability for roughly the cost of an env-var block.
- **Effort:** medium. One new dependency, one adapter, and a rule that MCP tools are treated like any
  other delegated read (permission gate + scrub still apply). Fits our "intent-first, deny=zero-wire"
  laws cleanly because an MCP call is just another wire read Jarvis chooses to make.
- **Prereq:** none — this *is* the prereq for the rest.

### A2. `catc-mcp` — richer Catalyst Center than our `catalyst-center.js` — **HIGH**
- **What:** read-only Catalyst Center server exposing **all 514 GET operations** through 10 tools
  (a `catc_find` search + typed dispatchers for devices/sites/wireless/health/compliance/software/
  events). Our `catalyst-center.js` hand-codes ~6 calls (devices, health, issues, Command Runner,
  running-config, pushConfig).
- **Why for us:** same appliance we already talk to, but 500 more read operations (compliance,
  wireless, software image, site health) without us writing each adapter by hand. Their design even
  matches our laws: **GET-only catalogue** (the one POST is deleted from the catalogue, not just
  guarded), and **every response is stamped** "empty inventory ≠ empty network" — that is literally
  our honest-if-absent law.
- **Effort:** medium (needs A1). Two honest cautions: it's a **Python** server (Cisco's generated
  catalogue + a thin client), and it "does not enforce read-only by RBAC" — it relies on curation +
  a least-privilege account. We'd point it at a read-only DevNet/lab account and keep our own gate in
  front. **Even without A1**, the *catalogue itself* (Apache-2.0 JSON of 514 operations with
  uri/method/params) is worth harvesting to extend our own `catalyst-center.js`.
- **Prereq:** A1 for the live server; nothing for the catalogue-harvest route.

### A3. `multivendor-cli-mcp` — the multivendor recipe for our SSH runner — **HIGH**
- **What:** a read-only CLI driver over **NAPALM/Netmiko** reaching ~90 platform families (MikroTik,
  VyOS, SONiC, SR Linux, Arista, Huawei, Dell…), with a **safety-critical filter** (`policy/filter.py`
  + `policy/platform_deny.py`) that is the best part.
- **Why for us:** we just built an SSH sidecar (Scrapli/Netmiko) but haven't wired it into
  live-agents. Their `filter.py` is a direct, battle-tested model for our `executeDeviceCli()`
  guardrail — and it flags a **class bug we should verify we don't have**: *chaining must be rejected
  BEFORE the allowlist check.* `show version; write erase` starts with an allowlisted token, so any
  guardrail that checks the allowlist first lets the destructive tail through. Their evaluation order
  is: (1) reject chaining/redirection, (2) reject denylisted first-token, (3) in read-only mode
  reject unless allowlisted, (4) permit. Their `platform_deny.py` also makes a sharp point: a
  Cisco-shaped denylist (`write erase`, `reload`) blocks *nothing* on VyOS/MikroTik/SONiC — so they
  keep a **universal verb denylist** (reload, erase, delete, rm, **and shell/bash/run/system** — a
  shell is an unbounded bypass) plus per-platform additions.
- **Why this is the highest-signal item in the repo for us:** even if we adopt zero of their code, we
  should read `filter.py`/`platform_deny.py` and harden our own guardrail to the same ordering and
  the same shell-escape ban. That's a pure **pattern lift** (see B1) with no MCP client needed.
- **Effort:** low to read-and-adopt-the-pattern; medium to run the server itself (needs A1 + a Python
  venv; they warn it pulls `cryptography` and must be venv-isolated).
- **Prereq:** none to adopt the safety pattern; A1 to run the server.

### A4. Telemetry feeds — `syslog-mcp`, `snmptrap-mcp`, `ipfix-mcp` — **HIGH**
- **What:** three self-contained UDP receivers that *listen* (syslog 514, SNMP traps 162, NetFlow/
  IPFIX 2055), parse (RFC 5424/3164, SNMPv1/2c/3, NetFlow v5/v9/IPFIX), dedupe, rate-limit, retain in
  memory, and expose a **query interface** as MCP tools (filter by time/severity/host/OID; "top
  talkers" for flows).
- **Why for us:** noc-triage's triage brain is strong at *pulling* state but has no live *push* feed.
  A syslog/trap feed is exactly what a real NOC bridge reasons over ("interface flap storm on sw3 at
  02:14"). Wire these in and Jarvis's investigation loop can correlate an operator's symptom window
  against the actual log/trap/flow record — closing the gap our correlation wave (`sources/
  correlation.js`) currently fills with adapter timestamps only.
- **Effort:** medium (needs A1). These are cleanly scoped Python, minimal deps, stdio MCP — good
  candidates to run as-is. Note they're **listeners**: they need devices pointed at them, so this is
  a lab/pilot thing before production.
- **Prereq:** A1.

### A5. `batfish-mcp` — offline "what-if" config analysis — **MED**
- **What:** wraps Batfish (runs in Docker) to analyze device configs **without touching live gear**:
  reachability tests, ACL/firewall-rule tracing, config diff between two snapshots, compliance checks
  (interface descriptions, no default route, NTP present, BGP sessions established).
- **Why for us:** our change engine does a five-step wrap around a *live* apply. Batfish lets Jarvis
  answer "would this change break reachability?" **before** any wire call — a genuinely new
  capability that fits our read-only-first posture perfectly (it never touches devices). Also good for
  our correlation loop: "did the running-config diff we found actually change who can reach what?"
- **Effort:** medium-high. Needs A1 **and** a running Batfish Docker container. More setup than the
  telemetry receivers, so it ranks below them.
- **Prereq:** A1 + Docker.

### A6. `packet-buddy-mcp` / packet capture analysis — **MED**
- **What:** deep pcap/pcapng analysis via `tshark`. (Thin server, minimal README.)
- **Why for us:** when triage bottoms out at "is the traffic even arriving?", handing Jarvis a pcap
  reader is a real escalation tool. Not an everyday NOC read, so mid-ranked.
- **Effort:** medium (A1 + tshark installed). 
- **Prereq:** A1 + Wireshark/tshark.

### A7. ServiceNow — **use the upstream `servicenow-mcp`, don't build CW-6 blind** — **MED**
- **What:** NetClaw *documents* a community `servicenow-mcp` (incidents, change requests, CMDB) but
  does **not** vendor it — it's installed on demand. What NetClaw *does* ship is the **workflow
  pattern** (see B2) and a fully-vendored **`halo-mcp`** ITSM server as a working reference.
- **Why for us:** our roadmap Wave 6 / CW-6 is two-way ServiceNow, currently "honest not-connected
  until Vikas provides creds." Rather than a hand-rolled client, the community `servicenow-mcp` (once
  we have A1) could be our two-way path — and `halo-mcp` is a clean, readable model of **how to gate
  the one write**: 17 read tools + **1 gated write** (`create_change_request` with
  `submit=false` returning a *preview of the exact POST body*, writing nothing unless `submit=true`).
  That preview-before-submit is exactly our permission-gate philosophy.
- **Effort:** medium. Honest caveat: our current CW-6 is already built as a native client; swapping to
  an MCP server is only worth it if we're adding the MCP client anyway. If not, **lift the halo-mcp
  gated-write shape** into our existing ServiceNow client (that's B2, no MCP needed).
- **Prereq:** A1 to run the server; none to copy the gated-write pattern.

### A8. Source-of-truth reconciliation — `nautobot-mcp-v2` (or `netbox-mcp`) — **MED**
- **What:** Nautobot server with a `nautobot_reconcile` tool that **compares live device state against
  the source-of-truth** and reports drift, plus ITSM-gated writes.
- **Why for us:** "source-of-truth stamping" is explicitly on our parked/backlog list. This gives
  Jarvis a real answer to "is the network what the records say it is?" — a strong triage signal
  (unexpected VLAN, wrong IP, missing cable). We don't run Nautobot today, so this is a "when we have
  a SoT" item, hence mid-ranked.
- **Effort:** medium (A1 + a Nautobot/NetBox instance).
- **Prereq:** A1 + a source-of-truth system to point at.

---

## BUCKET B — Patterns / ideas to adopt (design, not code)

*These need no MCP client and often no code from them at all — just adopt the shape.*

### B1. The command-safety ordering + shell-escape ban — **HIGH**
- **What:** from `multivendor-cli-mcp/policy/filter.py`: reject chaining/redirection **first**, then
  denylist, then allowlist; enforcement lives **in code, never in skill docs** ("documentation
  describes policy; it cannot enforce it, because an agent can phrase a request any way it likes");
  and **shell/bash/run/system are universally denied** because a shell bypasses every other rule.
- **Why for us:** directly hardens `executeDeviceCli()` — our single CLI choke point. Fix the *class*:
  make sure our guardrail rejects chaining before it consults the allowlist, and that it bans shell
  escapes on every platform, not just Cisco syntax. This is our "fix the class, not the case" law
  applied to their exact lesson.
- **Effort:** low. A focused review + test of our guardrail against their ordering.

### B2. ITSM-gated change lifecycle (preview-before-submit) — **HIGH**
- **What:** `servicenow-change-workflow` skill: check open P1/P2 on the affected CI → create CR with
  risk/impact/rollback → wait for approval (CR in `Implement`) → execute → close/escalate. Plus
  `halo-mcp`'s **gated single write** (dry-run preview of the exact request body).
- **Why for us:** our change engine's five-step wrap and permission gate already rhyme with this. Two
  concrete upgrades: (1) **block a change if there's an open P1/P2 on the target CI** — a cheap,
  high-value guard we don't have; (2) **preview the exact write payload** back to the operator before
  submit, for every write, not just some. Both are pure design lifts.
- **Effort:** low-medium.

### B3. Immutable audit trail ("GAIT") — **MED**
- **What:** every MCP server logs each action to an append-only audit trail (they use a Git-based
  "GAIT"; the `gait_logger.py` pattern falls back to structured logging if the service is absent).
- **Why for us:** we have an approval log and chat/activity persistence, but not one **tamper-evident,
  scrub-clean audit stream** of *every wire read and write Jarvis made*. Adopting an append-only
  audit record (hash-chained or Git-backed) would make our "honest, never fabricate" posture provable
  after the fact — useful the first time someone asks "what did the agent actually touch?"
- **Effort:** medium. Design + a new store; must obey our secrets-scrubbed law (log lengths, never
  values).

### B4. The "big search over a huge tool surface" trick — **MED**
- **What:** `catc-mcp` keeps 514 operations reachable through **10 tools** by hiding the 11k-token
  operation index behind a `catc_find(query)` search instead of listing every tool in the manifest.
- **Why for us:** as Jarvis's tool roster grows (agents + future MCP servers), we'll hit the same
  context-budget wall. Their answer — *a searchable capability index, not a flat list Jarvis must hold
  in its head* — is the right pattern for our delegation layer. Their **222-skill catalog** and
  `SOUL-SKILLS.md` structure (grouped by domain: pyATS, F5, memory, Catalyst, packet, nmap…) is a
  ready-made **capability map** to mine for "what should a CCIE-grade triage agent even be able to
  do?" — a checklist for future waves, not code.
- **Effort:** low to borrow the idea; the skills catalog is free reading.

### B5. Honest-absence stamping as a standard — **MED**
- **What:** `catc-mcp` stamps *every* response with the reason an empty result might be empty (no
  discovery, RBAC scope, filter, wrong appliance).
- **Why for us:** we already say "not connected/unreachable" honestly. Their refinement is to make the
  **empty-but-connected** case explicit ("this controller manages zero devices ≠ the network is
  empty"). Worth baking into our adapters' empty-result messaging so Jarvis never reads silence as
  absence.
- **Effort:** low.

---

## BUCKET C — Not relevant / incompatible (ruled out honestly)

- **Their entire Python agent runtime** (OpenClaw core, `src/netclaw_tokens` cost accounting,
  federation/N2N peering, certificate issuance, `SOUL*.md` persona, RALPH inputs). We're Node; this is
  their brain, not a library. An MCP *server* is a separate process so it's still usable — but their
  **internals are not drop-in** and we should not try to port them.
- **Out-of-scope integrations:** `blender_addon.py` (116KB 3D), `mobile/` (Dart/Swift apps), `twitter-mcp`,
  `twilio-voice-mcp`, `tts-mcp`, WebEx/Slack voice, `sketchfab`/`uml`/`markmap` diagram servers,
  Unreal Engine. Fun, irrelevant to NOC triage.
- **Computer-use / desktop automation** (`chrome-devtools-mcp` and similar): fights our read-only,
  deny=zero-wire posture and adds a huge attack surface for no triage value.
- **Lab/simulation servers** (`eve-ng`, `gns3`, `clab`, `gnmi` labs, `testbed/`): useful to *them* for
  building labs; we consume live sandboxes, so low priority unless we start shipping a lab mode.
- **Write-enabled config servers** run in write mode (`pyATS` config push, NetBox/Nautobot writes
  ungated, `nautobot-golden-config` remediation): only ever adopt these **read-only** or **behind our
  permission gate**. Their write paths fight our "writes blocked before the gate" law if wired
  naively.
- **The 100+ vendor servers we have no gear for** (Check Point ×15, Meraki, F5, Aruba, Prisma, ISE,
  FMC, Claroty OT, Zscaler, Cloudflare…): not *incompatible*, just **not actionable** until we have
  that vendor's equipment and creds. They're a menu for later, not a pull for now.

---

## Licensing (Apache-2.0)

NetClaw is **Apache-2.0** — permissive and compatible with reuse in a private/commercial app. If we
copy any of their **code** (e.g. lift `filter.py`'s logic, or vendor a server's Python), Apache-2.0
asks us to:
1. **Keep their copyright + license notice** on the copied files (include the Apache-2.0 text).
2. **Keep any `NOTICE` file** content they ship, and state that we changed the files if we modify
   them.
3. That's essentially it — no copyleft, no obligation to open our own source.

Note the **layered attribution**: some of their servers are themselves lifted from other projects
(their `catc-mcp` re-uses Cisco's Apache-2.0 catalogue with a `NOTICE.md`; their `filter.py` credits
an **MIT-licensed** `nornir-mcp-server`). If we lift *those* pieces, we inherit *those* upstream
notices too. **Adopting a pattern/idea (Bucket B) carries no license obligation** — only copied text
does. Cleanest path for us: prefer pattern-adoption; when we copy code, copy the notice with it and
keep a short `THIRD-PARTY-NOTICES.md`.

## Security (vet before wiring anything in)

This is third-party network tooling that will hold **credentials to real gear** — treat every server
as untrusted until reviewed. Before wiring any of them:

1. **Read the server's code, not just its README.** These are Python programs we'd run as child
   processes with our env. Confirm what hosts it contacts and that a "read-only" server truly issues
   no writes (NetClaw itself admits `catc-mcp` "does not enforce read-only by RBAC" — curation only).
2. **Least-privilege accounts, always.** Point each server at a **read-only** device/appliance account
   (their own guidance). Never hand a server admin creds.
3. **Our gate stays in front.** An MCP call is a wire read — it must pass the same permission gate
   (deny = zero wire) and our read-only guardrail. Don't let an external tool become a gate bypass.
4. **Secrets scrubbed, our law.** Creds go via env only (never tracked), and our scrub applies to
   anything an MCP server returns before it's persisted or shown. Their GAIT logger logs metadata —
   verify anything we adopt logs *lengths, never values*.
5. **Pin and isolate dependencies.** Their servers pull heavy Python (`napalm`, `cryptography`,
   `pybatfish`, `fastmcp`). Run each in its own venv/container so a version conflict or a compromised
   transitive dep can't reach our Node app. NetClaw itself hit `fastmcp` version collisions — expect
   dependency friction.
6. **Listeners open ports.** `syslog/snmptrap/ipfix` bind UDP sockets. Firewall them to lab sources
   before pointing production devices at them.
7. **Prefer the catalogue/pattern over the runtime** where we can (catc catalogue harvest, filter.py
   pattern) — copying a reviewed data file or a design carries far less risk than running someone
   else's live network program.

---

## Bottom line (ranked shortlist)

1. **Build the MCP client in Jarvis (A1)** — nothing else in Bucket A unlocks without it, and it's a
   contained piece of plumbing that fits our laws.
2. **Harden `executeDeviceCli()` against the chaining/shell-escape class (A3/B1)** — do this now, no
   MCP needed; it's a direct safety win from their hardest-won lesson.
3. **Harvest the `catc-mcp` catalogue (A2)** to grow `catalyst-center.js` reads — no MCP needed for
   the harvest route.
4. **Then, once A1 lands:** telemetry receivers (A4) for a live feed, Batfish (A5) for pre-change
   what-if, and the community ServiceNow server (A7) for Wave 6.
5. **Free design lifts (B2–B5):** open-P1/P2 change block, preview-before-submit, immutable audit
   trail, searchable capability index, empty-but-connected stamping.

Everything in Bucket C — their Python brain, the 3D/mobile/social/desktop tooling, and the 100+
vendor servers we have no gear for — we consciously leave on the shelf.
