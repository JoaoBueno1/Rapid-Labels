<#
.SYNOPSIS
  excel-sync delivery - the local transport's scheduler entry point.

.DESCRIPTION
  Writes the already-published dataset into the workbook tabs. It does NOT
  rebuild the dataset: that happens in GitHub Actions overnight, so if the
  Actions run failed this writes nothing new rather than something wrong - the
  delivery's own staleness gate refuses anything past its SLA.

  Why a script on this machine at all: the Graph transport would run in Actions
  like everything else. The local transport drives real Excel over the
  OneDrive-synced copies, so it needs a machine with Excel, with OneDrive signed
  in, switched on. A cloud cron cannot reach that. This is the cost of the
  bridge, written down.

  Two things this file must stay disciplined about, both learned the hard way:

    ASCII only. Windows PowerShell 5.1 reads a .ps1 as ANSI unless it carries a
    BOM, so an em dash in a comment becomes three bytes of garbage and the
    parser dies forty lines later with an error that points nowhere near it.

    Not $args. That is an automatic variable; assigning to it works until it
    quietly does not.

  It replaced a .cmd version: the test folder lives under "OneDrive - RapidLED",
  and batch quoting around a path holding both spaces and a hyphen kept failing
  with "- was unexpected at this time".

.PARAMETER Root
  Aim every binding at a folder of COPIES instead of the live library. Test mode
  also passes --force, because the bindings ship disabled. Running with no
  arguments against the live library therefore does nothing until somebody
  enables them one at a time in specs/bindings/ - going live is a deliberate
  act, not the absence of a flag.

  --force covers the disabled flag and the staleness gate ONLY. It does not
  override the header gate or the formula guard. That distinction was not
  always true and the trial was running without the header guard because of it
  (see engine/delivery/__init__.py, gate 2) - a rehearsal that switches off the
  guard it exists to trust is worse than no rehearsal.

.PARAMETER DryRun
  Rehearse: prove every gate, write nothing.

.EXAMPLE
  .\run_delivery.ps1 -Root "C:\Users\JoaoMarcos\OneDrive - RapidLED\Desktop\Tests files"

.EXAMPLE
  # register the trial run, every morning at 07:00
  $exe = "powershell.exe"
  $arg = '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\JoaoMarcos\Rapid-Labels\features\excel-sync\tools\run_delivery.ps1" -Root "C:\Users\JoaoMarcos\OneDrive - RapidLED\Desktop\Tests files"'
  schtasks /Create /TN "ExcelSync Trial" /SC DAILY /ST 07:00 /TR "$exe $arg" /RL LIMITED /F

  Leave the task on "Run only when user is logged on" - Excel COM needs an
  interactive session and will not start without one.
#>
[CmdletBinding()]
param(
  [string]$Root,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$engine = Split-Path -Parent $here
$logDir = Join-Path $engine 'out\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir ("delivery-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

$cmd = @('-m', 'engine', 'deliver', '--transport', 'local')
if (-not $DryRun) { $cmd += '--write' }
if ($Root) {
  if (-not (Test-Path $Root)) { throw "Root not found: $Root" }
  $cmd += @('--force', '--root', $Root)
  $mode = "TEST copies - $Root"
} else {
  $mode = 'LIVE library'
}

@(
  ''
  '============================================================'
  (" run started {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  (" target:  {0}" -f $mode)
  (" command: python {0}" -f ($cmd -join ' '))
  '============================================================'
) | Add-Content -Path $log -Encoding utf8

Push-Location $engine
try {
  # stderr merged deliberately: a refusal explains itself there, and a log
  # holding only the happy path is worse than no log.
  #
  # Streamed line by line, NOT buffered into a variable and written at the end.
  # Buffering it hid a 19-minute run behind a log holding nothing but its own
  # header, so there was no way to tell a slow run from a hung one - and on
  # 18 Aug that cost a wrong diagnosis of "it hung" when it was simply running.
  # A log you cannot watch is not a log.
  #
  # Add-Content -Encoding utf8 per line rather than Tee-Object, because
  # Tee-Object on PS 5.1 writes UTF-16 with no -Encoding switch. Mixed against
  # the UTF-8 header above it produced a file where the counting below matched
  # nothing: the 18 Aug run wrote 20 tabs and reported "0 written | 0 refused".
  # The summary is what the alerting will read, so it has to be true.
  #
  # Counting comes from $out, not from re-reading the log, because the log
  # accumulates every run of the day - and its own summary line ends in
  # "0 refused", which a case-insensitive match once counted as a refusal.
  $out = & python @cmd *>&1 | ForEach-Object {
    $line = $_.ToString()
    Add-Content -Path $log -Value $line -Encoding utf8
    $line
  }
  $rc = $LASTEXITCODE
  $out | ForEach-Object { Write-Output $_ }
} finally {
  Pop-Location
}

$wrote   = @($out | Select-String -Pattern 'OK . \d+ rows in').Count
$refused = @($out | Select-String -Pattern 'REFUSE ').Count
$failed  = @($out | Select-String -Pattern '^\s*FAILED ').Count
# The expected count is not a magic number: it is how many bindings exist on
# disk. A run that writes 20 of 21 looks like a success to anything counting
# only errors, and 20 of 21 is exactly what 18 Aug produced.
$expected = @(Get-ChildItem (Join-Path $engine 'specs\bindings') -Filter '*.toml').Count
$summary = " exit {0} | {1}/{2} written | {3} refused | {4} failed" -f $rc, $wrote, $expected, $refused, $failed
$summary | Add-Content -Path $log -Encoding utf8

# A rehearsal writes nothing by definition, so the shortfall check applies only
# to a real run. Without this the dry run reports 0/21 and exits 1, which trains
# whoever watches it to ignore a red exit - the one habit this must not create.
$short = (-not $DryRun) -and ($wrote -lt $expected)
$bad = ($rc -ne 0) -or ($refused -gt 0) -or ($failed -gt 0) -or $short
if ($bad) {
  Write-Output "excel-sync: $wrote/$expected written, $refused refused, $failed failed, exit $rc - see $log"
  # Non-zero so Task Scheduler shows the run as failed rather than as a silent
  # success. A refusal is correct behaviour and still needs to be seen.
  exit 1
}

Write-Output "excel-sync: $wrote/$expected written - see $log"
exit 0
