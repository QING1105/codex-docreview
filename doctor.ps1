param(
 [string]$SkillsRoot = $(if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills' } else { Join-Path $env:USERPROFILE '.agents\skills' }),
 [switch]$SkipPortCheck, [switch]$Json, [switch]$SkipMcp
)
$ErrorActionPreference = 'Stop'
$entry = Join-Path $SkillsRoot 'doc-review\scripts\run.ps1'
if (-not (Test-Path -LiteralPath $entry)) { $entry = Join-Path $PSScriptRoot 'skills\doc-review\scripts\run.ps1' }
if (-not (Test-Path -LiteralPath $entry)) { $entry = Join-Path $PSScriptRoot '..\run.ps1' }
$arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$entry,'--doctor')
if ($SkipPortCheck) { $arguments += '--skip-port' }
& powershell.exe @arguments
exit $LASTEXITCODE
