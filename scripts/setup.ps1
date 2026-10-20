# AEGIS developer setup (Windows PowerShell 5.1+). Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# Creates services\core\.venv with Python 3.12 and installs pinned packages,
# then installs the desktop app's npm packages from package-lock.json.
# Changes nothing outside this repository (npm/pip caches aside).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$core = Join-Path $root 'services\core'
$desktop = Join-Path $root 'apps\desktop'
$venvPython = Join-Path $core '.venv\Scripts\python.exe'

function Invoke-Checked([string]$what, [scriptblock]$block) {
  Write-Host "==> $what"
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw 'The Python launcher (py) was not found. Install Python 3.12 from python.org.'
}
& py -3.12 --version
if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is not installed (py -3.12 failed).' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm was not found. Install Node.js LTS (22.12+).'
}

if (-not (Test-Path $venvPython)) {
  Invoke-Checked 'Create Python 3.12 virtual environment' { py -3.12 -m venv (Join-Path $core '.venv') }
}
Invoke-Checked 'Install core Python packages' {
  & $venvPython -m pip install --disable-pip-version-check -r (Join-Path $core 'requirements-dev.txt')
}

Push-Location $desktop
try {
  Invoke-Checked 'Install desktop npm packages (npm ci)' { npm ci }
} finally {
  Pop-Location
}
Write-Host ''
Write-Host 'Setup complete. Start the app with: powershell -ExecutionPolicy Bypass -File scripts\start.ps1'
