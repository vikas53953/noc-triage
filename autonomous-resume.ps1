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

# Only resume when NO driver is actively working this repo. Process-name checks
# proved wrong twice (claude runs as claude.exe, not node.exe — the old check
# matched nothing and stacked sessions; and idle/stale claude.exe windows would
# make an "any claude.exe" check block resume forever). Class fix: detect a live
# driver by its WORK PRODUCT — any driver (interactive, headless, another
# launcher) touches the repo's git state / TRACKER / log every turn. If none of
# those changed recently, the work is dead and a resume is warranted. A rare
# duplicate spawn during a long quiet turn is tolerated waste (TRACKER rule:
# every driver re-checks PR state before merging); a never-firing launcher is not.
$signals = @(
  (Join-Path $repo '.git\HEAD'),
  (Join-Path $repo '.git\FETCH_HEAD'),
  (Join-Path $repo '.git\index'),
  (Join-Path $repo 'TRACKER.md'),
  (Join-Path $repo 'autoresume.log')
)
$latest = $signals | Where-Object { Test-Path $_ } |
  ForEach-Object { (Get-Item $_).LastWriteTime } |
  Sort-Object -Descending | Select-Object -First 1
if ($latest -and ((Get-Date) - $latest).TotalMinutes -lt 30) { exit 0 }

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
