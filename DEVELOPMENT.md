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
`services\core\requirements-dev.txt`, downloads Playwright's Chromium headless shell into
that venv (`PLAYWRIGHT_BROWSERS_PATH=0`, nothing goes into your user profile), and runs `npm ci` in `apps\desktop`
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

## Research (Phase 3)

Type a message that contains public `https://` URLs, for example
`Research how asyncio tasks are cancelled https://docs.python.org/3/library/asyncio-task.html`.
A message starting with "research" but without a usable URL is answered with an explanation;
any other message stays an ordinary chat turn.

- **Sources:** only the URLs in your message (max 5). There is **no web search**. http://, IP
  addresses, non-443 ports, `localhost`/`.local`/`.internal` names, embedded credentials and
  names that resolve to private, loopback, link-local or reserved addresses are refused before
  anything is fetched, and again at every redirect and at connect time.
- **Plan → approve:** the plan (question, key terms, exact source list, refusals) is shown first;
  nothing is fetched until you approve it.
- **Reading:** robots.txt is honoured; each page (≤ 2 MB, ≤ 40,000 characters of text) is fetched by
  the core and rendered in a fresh headless Chromium context with JavaScript off and every
  sub-request blocked. Pages that need JavaScript, PDFs and sites that refuse automated clients
  (for example Wikipedia, which answers HTTP 403 to clients without contact details in the
  User-Agent) are reported as failed/blocked.
- **Report:** one model call writes findings that must cite passage ids and quote them; code checks
  every citation, quote, key word and number and labels each finding supported / weak / unsupported /
  removed. The Markdown is rendered by code (links are only fetched URLs).
- **Save:** *Save report…* opens a folder picker; the core writes a new
  `aegis-research-<time>-<id>.md` (never overwriting) and re-reads it to verify the hash.
  *Open report* opens that file with your default Markdown app.

Live checks (skipped unless enabled; a skip is not a pass):

```powershell
$env:AEGIS_LIVE_WEB = '1'; $env:AEGIS_LIVE_MODEL = 'qwen3:4b'
services\core\.venv\Scripts\python -m pytest services\core	ests	est_research_live.py -s
```

## Memory (workstream M0)

Local only, in the same SQLite database (schema v5: `memory_events`, `memory_facts`, `memory_fts`,
`memory_retrievals`). Open **Memory** in the bottom drawer to search, add, correct, confirm, reject or delete.

- **What is captured:** a chat message that starts with `Remember …` (stored verbatim as your statement);
  a completed file task or saved research report (stored by code as a verified task outcome); and, for
  messages that look like standing instructions ("From now on…", "I prefer…", "Call me…"), up to three
  model-proposed **candidates** that are never used until you confirm them. The checkbox in the panel
  turns automatic capture off. Nothing else is captured (no screen, clipboard, keystrokes or files).
- **What a reply sees:** up to 3 of your stated/confirmed preferences plus up to 6 FTS5 matches, all
  `active` and unexpired, in the global scope or the current project. They go in as one labelled,
  quoted system note; your message is passed on unchanged. Which versions were used is recorded per reply.
- **Corrections** add a new version; the old one stays visible under *Show history* as superseded.
  Two statements with the same subject are both marked **disputed** (not used) until you confirm one.
- **Secrets** (keys, tokens, passwords, private keys) are refused. **Delete** removes every version.

Live checks (skipped unless enabled):

```powershell
$env:AEGIS_LIVE_MODEL = 'qwen3:4b'
services\core\.venv\Scripts\python -m pytest services\core\tests\test_memory_live.py -s
```

GUI round trip (remember → restart → recall → correct → recall) in the real app:

```powershell
$env:AEGIS_SMOKE_MEMORY_MODEL = 'qwen3:4b'; npm --prefix apps\desktop run smoke
```

Set `AEGIS_SMOKE_MEMORY_PHASE` to `remember`, then `recall`, with the same `AEGIS_SMOKE_USER_DATA`
folder for both runs to make the restart a full application restart.

## Vaults (workstream M0A)

Open **Vaults** in the bottom drawer and choose **Add vault…**. Pick either an existing Obsidian vault
(a folder with `.obsidian/`, registered **read-only**) or an empty folder (a new AEGIS vault whose
`AEGIS/` folder AEGIS may write to). Any other folder is refused.

- **Indexed:** `.md` files up to 1 MB (max 5000 per vault), not inside hidden folders (`.obsidian`,
  `.git`, `.trash`), never through links or junctions. Notes that look like they contain secrets are
  skipped. Title, tags, aliases and wikilinks come from frontmatter and text.
- **Search** re-scans a vault first if its index is more than 10 s old, so edits made in Obsidian or any
  editor show up; **Re-index now** does it immediately. Each change is kept as a hashed version.
- **Open** hands the note to your default Markdown app. **Create note** writes a new file in `AEGIS/`
  only and never overwrites; it shows as "added via AEGIS" until edited outside AEGIS.
- Note text is only searched; it is not sent to the model. **Remove** forgets the index; files stay.

GUI acceptance run (needs a new or empty folder):

```powershell
$env:AEGIS_SMOKE_VAULT_DIR = "$env:TEMP\aegis-vault-check"; npm --prefix apps\desktop run smoke
```

## Troubleshooting

- **"The isolated browser could not start"** on a research task: run `scripts\setup.ps1` again
  (it installs the Chromium headless shell into the venv).

- **"Python environment not found"** in the status: run `scripts\setup.ps1`.
- **Port 5173 in use** (dev mode only): close the other Vite instance; the dev server will not pick another port.
