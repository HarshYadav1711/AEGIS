# Build and launch AEGIS (production renderer from apps\desktop\dist).
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
$ErrorActionPreference = 'Stop'
$desktop = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps\desktop'
Push-Location $desktop
try {
  npm run start
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
