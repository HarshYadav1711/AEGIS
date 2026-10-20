# Launch AEGIS against the Vite dev server (hot reload for the renderer).
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
$ErrorActionPreference = 'Stop'
$desktop = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps\desktop'
Push-Location $desktop
try {
  npm run dev
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
