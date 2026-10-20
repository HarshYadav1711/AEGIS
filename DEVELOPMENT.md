# AEGIS — Development Setup and Running (Phase 0)

Windows-first. All commands are for **Windows PowerShell 5.1** or PowerShell 7, run from the repository root.

## Prerequisites

| Tool | Required | Verified on this machine (2026-10-21) |
|---|---|---|
| Node.js | 22.12+ (LTS) | 24.19.0 |
| npm | bundled with Node | 11.17.0 |
| Python | 3.12 via the `py` launcher | 3.12.0 (`py -3.12`) |

Nothing is installed globally. Setup creates `services\core\.venv` and `apps\desktop\node_modules` only.

## Fresh install

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

This creates the Python 3.12 virtual environment, installs pinned packages from
`services\core\requirements-dev.txt`, and runs `npm ci` in `apps\desktop`
(Electron's install script downloads its runtime binary).

## Run

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

Builds the renderer and Electron main, then opens the AEGIS window. Electron main
starts the Python core itself; you never run the backend by hand.

Development mode with renderer hot reload (Vite dev server on `127.0.0.1:5173`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

## Checks

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check.ps1
```

Runs pytest, TypeScript checks, ESLint, unit tests and the Electron smoke test.
The smoke test opens the real window for roughly 15 seconds; use `-NoGui` to skip it.
Set `AEGIS_SMOKE_SCREENSHOT_DIR` to a folder to save screenshots from the smoke run.

## What runs where

```
Electron main (apps/desktop/electron)
 ├─ spawns  services/core/.venv/Scripts/python.exe -m app.main   (fixed path, no shell)
 │    stdin  ← per-launch 256-bit token (never argv/env/logs/renderer)
 │    stdout → AEGIS_READY {"port": N}   (core bound to 127.0.0.1:N, OS-assigned)
 │    stdin EOF → graceful shutdown
 ├─ polls   GET http://127.0.0.1:N/health  every 2 s with Authorization: Bearer <token>
 └─ pushes  BackendStatus → renderer over one typed IPC channel
Preload (sandboxed) exposes window.aegis = { getBackendStatus, restartBackend, onBackendStatus, getAppInfo }
Renderer (React) has no Node, no network (CSP connect-src 'none'), draws the orb from that status.
```

- Local database: `%APPDATA%\AEGIS\aegis.db` (SQLite, WAL, schema migrations in `services/core/app/memory/db.py`).
- Orb states driven by real events in Phase 0: `connecting` (core starting), `idle` (healthy),
  `error` (failed to start or degraded), `offline` (process exited or stopped answering).
  Every other state is shown only through the **Development state preview (simulated)** panel and is labelled on the orb.

## Manual GUI check

1. Run `scripts\start.ps1`. The window opens; within a few seconds the header reads **Core: online** and the orb says **Ready — Local core is healthy.**
2. Open **Diagnostics**: schema version 1, journal mode `wal`, chat capability "not available (Phase 1)".
3. End the core in Task Manager (`python.exe` whose command line contains `app.main`). Within about 2 seconds the orb dims, the status reads **Offline — Core process exited …**, and a **Restart core** button appears. Click it: the status returns to **Ready**.
4. **Display → Motion → Reduced**: the orb stops animating; status text is unchanged.
5. Press Tab: focus moves through orb, message box and panels with a visible focus ring. Activating the orb focuses the message box. **Send** stays disabled because no model exists yet.
6. Close the window: no `python.exe … app.main` process should remain.

## Troubleshooting

- **"Python environment not found"** in the status: run `scripts\setup.ps1`.
- **Port 5173 in use** (dev mode only): close the other Vite instance; the dev server will not pick another port.
