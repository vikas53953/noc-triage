# Mission Control

A chat-first dashboard for a squad of network agents.

You type a question in plain English — "check device health", "show version",
"any open incidents?" — and the agent that owns that area answers with **real
data read live from Cisco DevNet always-on sandboxes**.

The rule the whole project is built around: **no made-up data, ever.** If an
agent has no data source wired up, it says "not connected". If its source is
unreachable, it says so and stops. It will not fill the gap with a plausible
looking report.

## Screenshot

_Coming soon._

<!-- TODO: save a screenshot of the dashboard at localhost:3000 to docs/screenshot.png,
     then replace the line above with:
     ![Mission Control dashboard](docs/screenshot.png)
     Keep it commented out until the file exists — GitHub renders a broken image otherwise. -->

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
cp .env.example .env.local   # Windows: copy .env.example .env.local
node server.js
```

Then open <http://localhost:3000>.

The dashboard runs without any credentials — every agent simply reports
"not connected" until you fill in `.env.local`. Nothing breaks, and nothing is
invented in the meantime.

## Getting sandbox credentials

The live data comes from Cisco's free always-on sandboxes at
[devnetsandbox.cisco.com](https://devnetsandbox.cisco.com). Create a free
Cisco account, find the always-on sandbox for each platform below, and copy its
username and password into `.env.local`:

| Platform | What it gives you | Host in `.env.example` |
|---|---|---|
| Catalyst Center | Campus switches, health scores, open issues, Command Runner | `sandboxdnac.cisco.com` |
| ACI / APIC | Nexus fabric nodes, tenants, faults | `sandboxapicdc.cisco.com` |
| SD-WAN vManage | Overlay routers, controllers, alarms | `sandbox-sdwan-2.cisco.com` |

`.env.local` is gitignored. Never commit real credentials — this repo is public.

Each source stands on its own. If only Catalyst Center is filled in, the
Catalyst-backed answers are live and the rest honestly report nothing.

## The read-only guarantee

This squad reads real network kit. It never changes it.

- **Command allowlist in code.** Only `show`, `ping`, `traceroute`, `dir` and
  `more` are allowed through. Every other verb is rejected before any request
  is built (`sources/guardrails.js`).
- **No chaining.** Pipes, semicolons, redirects and backticks are blocked, along
  with keywords like `config`, `write`, `erase`, `reload`, `copy`, `delete` and
  `clear` — the usual ways a read gets turned into a write.
- **No configuration changes, ever.** Ask an agent to change something and it
  refuses and tells you nothing was sent to any device.
- **Blocks are visible.** When a command is rejected you see the reason on
  screen, not a silent failure.

## Which agents are live

Seven of the ten agents answer from a real sandbox today. Three have no data
source yet and say so rather than guessing.

| Agent | Status | Source behind it |
|---|---|---|
| Jarvis (squad lead) | Live | All connected sources — one combined picture |
| NetOps | Live | Catalyst Center — device inventory and health |
| Monitor-Eye | Live | Catalyst Center health and issues + SD-WAN alarms |
| Incident-Handler | Live | Catalyst Center issues + ACI faults |
| Router-Expert | Live | ACI fabric (nodes, tenants, tenant audit) or SD-WAN overlay |
| Config-Keeper | Live | Catalyst Center Command Runner — real `show` output |
| Doc-Writer | Live | All sources — writes an inventory document from live reads |
| Sentinel | Not connected | Needs a CVE / threat feed (Umbrella or Talos) |
| Firewall-Pro | Not connected | Needs a firewall source (Cisco Secure Firewall / FMC) |
| LoadBal-Pro | Not connected | Needs a load-balancer source (F5 — no DevNet equivalent) |

"Not connected" is a real answer here, not a bug. Those three agents will keep
saying it until someone wires a source behind them.

## How it is put together

- `server.js` — the web server, the agent registry and the chat dispatcher
- `sources/` — one read-only adapter per platform, plus the command guardrail
- `public/index.html` — the dashboard the browser loads
- `.env.example` — the credentials template to copy to `.env.local`

Plain Node and Express, WebSockets for live updates, no build step.

## License

MIT — see [LICENSE](LICENSE).
