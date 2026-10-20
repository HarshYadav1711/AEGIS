# Run every Phase 0 check. Exits non-zero on the first failure.
#   powershell -ExecutionPolicy Bypass -File scripts\check.ps1           (all checks)
#   powershell -ExecutionPolicy Bypass -File scripts\check.ps1 -NoGui    (skip the Electron smoke test)
param([switch]$NoGui)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$core = Join-Path $root 'services\core'
$desktop = Join-Path $root 'apps\desktop'

function Invoke-Step([string]$name, [string]$dir, [scriptblock]$block) {
  Write-Host "==> $name"
  Push-Location $dir
  try {
    & $block
    if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

Invoke-Step 'Core tests (pytest)' $core { & (Join-Path $core '.venv\Scripts\python.exe') -m pytest }
Invoke-Step 'Desktop typecheck' $desktop { npm run typecheck }
Invoke-Step 'Desktop lint' $desktop { npm run lint }
Invoke-Step 'Desktop unit tests' $desktop { npm test }
if ($NoGui) {
  Invoke-Step 'Desktop build' $desktop { npm run build }
  Write-Host 'Skipped Electron smoke test (-NoGui).'
} else {
  Invoke-Step 'Electron smoke test (builds, opens a window briefly)' $desktop { npm run smoke }
}
Write-Host 'All checks passed.'
