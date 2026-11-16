param(
 [string]$SkillsRoot = $(if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills' } else { Join-Path $env:USERPROFILE '.agents\skills' }),
 [string]$InstallRoot = $(if ($env:DOCREVIEW_INSTALL_ROOT) { $env:DOCREVIEW_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'DocReview' }),
 [string]$PackageSource = $env:DOCREVIEW_PACKAGE_SOURCE,
 [string]$PythonExe = '',
 [string]$UvExe = '',
 [switch]$SkipMcp,
 [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $PackageSource) {
 if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'pyproject.toml'))) { $PackageSource = $PSScriptRoot }
 else { $PackageSource = 'https://github.com/QING1105/codex-docreview/archive/refs/heads/main.zip' }
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if ($CheckOnly) {
 $entry = Join-Path $SkillsRoot 'doc-review\scripts\run.ps1'
 if (-not (Test-Path -LiteralPath $entry)) { throw 'Run install.cmd once to prepare Doc Review.' }
 & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $entry --doctor
 exit $LASTEXITCODE
}
Write-Output '[1/4] Preparing the private runtime'
if (-not $PythonExe) {
 if (-not $UvExe) {
  $UvExe = Join-Path $InstallRoot 'tools\uv.exe'
  if (-not (Test-Path -LiteralPath $UvExe)) {
   New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UvExe) | Out-Null
   $oldUvDir = $env:UV_UNMANAGED_INSTALL
   try {
    $env:UV_UNMANAGED_INSTALL = Split-Path -Parent $UvExe
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $installer = Invoke-RestMethod 'https://astral.sh/uv/install.ps1'
    & ([scriptblock]::Create($installer))
   } finally { $env:UV_UNMANAGED_INSTALL = $oldUvDir }
   if (-not (Test-Path -LiteralPath $UvExe)) { throw 'Runtime download failed. Run the installer again to retry.' }
  }
 }
 $oldPythonDir = $env:UV_PYTHON_INSTALL_DIR
 $oldCacheDir = $env:UV_CACHE_DIR
 try {
  $env:UV_PYTHON_INSTALL_DIR = Join-Path $InstallRoot 'python'
  $env:UV_CACHE_DIR = Join-Path $InstallRoot 'cache'
  $venv = Join-Path $InstallRoot 'env'
  $PythonExe = Join-Path $venv 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $PythonExe)) {
   & $UvExe venv --python 3.12 --managed-python --seed $venv
   if ($LASTEXITCODE -ne 0) { throw 'Python setup failed. Run the installer again to retry.' }
  }
  Write-Output '[2/4] Installing Doc Review and its dependencies'
  & $UvExe pip install --python $PythonExe --upgrade $PackageSource
  if ($LASTEXITCODE -ne 0) { throw 'Package installation failed. Run the installer again to retry.' }
 } finally { $env:UV_PYTHON_INSTALL_DIR = $oldPythonDir; $env:UV_CACHE_DIR = $oldCacheDir }
} else {
 Write-Output '[2/4] Installing into the selected Python environment'
 & $PythonExe -m pip install --upgrade $PackageSource
 if ($LASTEXITCODE -ne 0) { throw 'Package installation failed. See the pip output above.' }
}
Write-Output '[3/4] Installing the skill and checking document tools'
$arguments = @('-m', 'codex_docreview', 'install', '--skills-root', $SkillsRoot)
if ($SkipMcp) { $arguments += '--skip-mcp' }
& $PythonExe @arguments
if ($LASTEXITCODE -ne 0) { throw 'Skill setup needs attention. Follow the check result above, then retry.' }
Write-Output '[4/4] Ready. Reload Codex and enter: $doc-review'
