# Autonomous resume launcher for noc-triage.
# Fires on a schedule (Windows Task Scheduler). Each run starts a FRESH claude
# session in the repo — a new session has no quota carryover, so this survives a
# quota wall that a same-session timer cannot. The fresh session reads TRACKER.md
# + HANDOFF.md and continues the top pending item.
#
# It exits immediately if a claude is already running in this repo (no stacking).

$ErrorActionPreference = 'SilentlyContinue'
$repo = 'C:\Users\vikasmit\noc-triage'
$lock = Join-Path $env:TEMP 'noc-triage-autoresume.lock'

# Only resume when NO session is alive. If a claude/node session is already
# running, a live session (interactive or a prior resume) is handling the work —
# skip, so we never stack two sessions pushing to the same repo. This launcher
# is meant to revive the work ONLY after a session has died (e.g. quota wall).
$alive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'claude' }
if ($alive) { exit 0 }

# Second guard: don't stack rapid re-launches.
if (Test-Path $lock) {
  $age = (Get-Date) - (Get-Item $lock).LastWriteTime
  if ($age.TotalMinutes -lt 25) { exit 0 }
}
New-Item -ItemType File -Path $lock -Force | Out-Null

Set-Location $repo

$prompt = @'
AUTONOMOUS RESUME (scheduled, Vikas is away). Read TRACKER.md and HANDOFF.md in this repo first — they
are the single source of truth. Then continue the top PENDING item in TRACKER.md "Next actions": review
and merge any approved PR (gh pr list), resume any fix loop, implement the next QA fix-class. Do NOT wait
for approval. Fix the CLASS not the case. No static bindings — intent first. Ambiguity → ask. Never
fabricate; verify live before claiming done. Keep TRACKER.md + HANDOFF.md updated and pushed every step.
If everything is genuinely done, update TRACKER and stop.
'@

# Uses Vikas's standard headless launch (see memory: session startup command).
& claude --dangerously-skip-permissions -p $prompt *> (Join-Path $repo 'autoresume.log')
