# Autonomous resume launcher for noc-triage.
# Fires on a schedule (Windows Task Scheduler). Each run starts a FRESH claude
# session in the repo — a new session has no session-quota carryover, so this
# survives a session-limit wall that a same-session timer cannot. The fresh
# session reads TRACKER.md + HANDOFF.md and continues the top pending item.
#
# HARD-LEARNED: a scheduled task runs with a stripped PATH, so `& claude` (the
# npm PATH shim) resolves to nothing and dies silently (6-byte empty log). Fix:
# call claude by ABSOLUTE PATH, never via PATH. Log launcher decisions to a
# SEPARATE file from the claude session output so failures are diagnosable.

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\vikasmit\noc-triage'
$lock = Join-Path $env:TEMP 'noc-triage-autoresume.lock'
$diag = Join-Path $repo 'autoresume-launcher.log'   # launcher decisions
$out  = Join-Path $repo 'autoresume.log'            # fresh claude session output
$claude = 'C:\Users\vikasmit\AppData\Roaming\npm\claude.cmd'  # ABSOLUTE, no PATH dependency

function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $diag -Append -Encoding utf8 }

# Liveness by WORK PRODUCT: any live driver touches git state / TRACKER every
# turn. If nothing changed in 30 min, the work is dead → resume warranted.
# (autoresume.log deliberately NOT a signal — the launcher writes it itself.)
$signals = @(
  (Join-Path $repo '.git\HEAD'),
  (Join-Path $repo '.git\ORIG_HEAD'),
  (Join-Path $repo '.git\index'),
  (Join-Path $repo 'TRACKER.md')
)
$latest = $signals | Where-Object { Test-Path $_ } |
  ForEach-Object { (Get-Item $_).LastWriteTime } |
  Sort-Object -Descending | Select-Object -First 1
if ($latest -and ((Get-Date) - $latest).TotalMinutes -lt 30) { Log "skip: work-product fresh ($latest)"; exit 0 }

if (Test-Path $lock) {
  $age = (Get-Date) - (Get-Item $lock).LastWriteTime
  if ($age.TotalMinutes -lt 25) { Log "skip: lock fresh"; exit 0 }
}
New-Item -ItemType File -Path $lock -Force | Out-Null

if (-not (Test-Path $claude)) { Log "ABORT: claude.cmd missing at $claude"; exit 1 }
Set-Location $repo

$prompt = @'
AUTONOMOUS RESUME (scheduled, Vikas is away). Read TRACKER.md and HANDOFF.md in this repo first — they
are the single source of truth. Then continue the top PENDING item in TRACKER.md "Next actions": review
and merge any approved PR (gh pr list), resume any fix loop, implement the next QA fix-class. Do NOT wait
for approval. Fix the CLASS not the case. No static bindings — intent first. Ambiguity → ask. Never
fabricate; verify live before claiming done. Keep TRACKER.md + HANDOFF.md updated and pushed every step.
If everything is genuinely done, update TRACKER and stop.
'@

$headBefore = (git -C $repo rev-parse HEAD 2>$null)
Log "launch: starting fresh claude session via $claude (HEAD $headBefore)"
try {
  # Absolute path to the .cmd shim, called directly by PowerShell. The ORIGINAL
  # bug was the bare `claude` name (PATH-dependent, empty under the task's PATH);
  # an absolute path removes that dependency entirely.
  & $claude --dangerously-skip-permissions -p $prompt *> $out
  $code = $LASTEXITCODE
  $bytes = (Get-Item $out -ErrorAction SilentlyContinue).Length
  git -C $repo fetch -q origin 2>$null
  $headAfter = (git -C $repo rev-parse HEAD 2>$null)
  $remote = (git -C $repo rev-parse origin/master 2>$null)
  # Fail-loud: a session that "finished" but moved nothing is suspect (sandboxed
  # writes + a hallucinated "done"). Record the truth, never assume success.
  if ($headBefore -eq $headAfter -and $remote -eq $headBefore) {
    Log "WARN: claude exited $code ($bytes bytes) but NOTHING landed (HEAD unchanged, no push). Likely sandboxed/blocked or quota wall — treat as NOT resumed."
  } else {
    Log "OK: claude exited $code ($bytes bytes); HEAD $headBefore -> $headAfter (remote $remote)"
  }
} catch {
  Log "ERROR launching claude: $($_.Exception.Message)"
}
