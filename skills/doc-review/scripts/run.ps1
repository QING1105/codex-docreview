param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ToolArguments)
$ErrorActionPreference = 'Stop'
$node = Join-Path $PSScriptRoot 'runtime\bin\node.exe'
$runtime = Join-Path $PSScriptRoot 'runtime'
$expectedVersion = '0.8.3'
$manifest = Join-Path $runtime '.codex-plugin\plugin.json'
$installedVersion = if (Test-Path -LiteralPath $manifest) { (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version } else { '' }
if (-not (Test-Path -LiteralPath $node) -or $installedVersion -ne $expectedVersion) {
 $skills = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
 & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'bootstrap.ps1') -SkillsRoot $skills -SkipMcp | ForEach-Object { [Console]::Error.WriteLine($_) }
 if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
 $runtime = Join-Path $skills 'doc-review\scripts\runtime'
 $node = Join-Path $runtime 'bin\node.exe'
}
$script = 'client.js'
if ($ToolArguments.Count -gt 0 -and $ToolArguments[0] -in @('--doctor','--mcp')) {
 $script = if ($ToolArguments[0] -eq '--doctor') { 'doctor.js' } else { 'mcp.js' }
 $ToolArguments = @($ToolArguments | Select-Object -Skip 1)
}
& $node (Join-Path $runtime "server\$script") @ToolArguments
exit $LASTEXITCODE
