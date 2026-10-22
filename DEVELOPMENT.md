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
- Note text is only searched, except when you explicitly allow up to 3 listed notes for one repository
  investigation (see below). **Remove** forgets the index; files stay.

GUI acceptance run (needs a new or empty folder):

```powershell
$env:AEGIS_SMOKE_VAULT_DIR = "$env:TEMP\aegis-vault-check"; npm --prefix apps\desktop run smoke
```

## Repository investigation (Phase 4)

Ask for it in the composer, e.g. *Analyze this repository, explain its architecture, identify important
problems, and suggest improvements.* (requests with URLs go to research instead).

- **Choose repository…** opens a folder picker in Electron main; the renderer never sends a path. The
  core refuses drive roots, network paths, links/junctions in the path and the app's data folder.
- **Read-only scan** (no model): never runs code, scripts, tests, builds or package managers; opens files
  only for reading and never through a link. Skips `.git`, dependencies (`node_modules`, virtual
  environments, `vendor`), build output and caches, hidden entries, lockfiles, binaries, files over
  256 kB and secret-bearing files (`.env*`, keys, `credentials*`, `*secret*` … listed by path only, never
  opened). Bounds: 5000 files inventoried, 1500 files / 8 MB read, 12 excerpts / 20 000 characters to the
  model. It derives languages, manifests and dependencies (with line numbers), frameworks, components,
  import relationships and deterministic checks (credential patterns, bare `except`, `eval`/`exec`,
  `shell=True`, TLS verification off, `.env` not ignored, unpinned dependencies, missing tests/README/
  LICENSE/lockfile) with file:line references.
- **Plan** shows all of that, the exact excerpts the model will see, the current memories that will be
  used (repository scope `project:<folder name>` + global) and up to 3 vault notes with author, version and
  SHA-256. Vault notes go to the model only if you tick the consent box, only with a local model, and only
  if each file still has the listed hash. Approval is bound to the plan digest.
- **Run:** excerpts are re-read and hash-checked; memories that changed since the plan, or that are
  project memories naming a framework the manifests do not declare, are withheld and listed. One model
  call (context window 12 288 tokens). Code then checks every model finding: the cited excerpt and lines
  must exist and the quote must occur in the real file → *likely issue / plausible concern / best
  practice*, otherwise *insufficient evidence* or *removed*. Hypotheses are shown with supporting and
  contradicting points, labelled unverified. The Markdown is rendered by code.
- **Save report…** writes a new `aegis-repo-<name>-<time>-<id>.md` to a folder you pick (never inside the
  repository, never overwriting), verifies its hash and re-checks that the repository is unchanged. The
  outcome is stored as a verified experience in the repository scope. *Add to memory* stores one of the
  code-built proposals as your own statement; nothing is stored without that click.

Live check (skipped unless enabled):

```powershell
$env:AEGIS_LIVE_MODEL = 'qwen3:4b'
services\core\.venv\Scripts\python -m pytest services\core\tests\test_repo_live.py -s
```

GUI acceptance run on a sample repository (the harness answers only the native folder dialogs):

```powershell
$env:AEGIS_SMOKE_REPO_MODEL = 'qwen3:4b'; $env:AEGIS_SMOKE_REPO_DIR = 'D:\samples\aegis-sample-inventory'
$env:AEGIS_SMOKE_REPO_OUT = 'D:\samples\reports'; $env:AEGIS_SMOKE_REPO_VAULT_DIR = "$env:TEMP\aegis-repo-vault"
npm --prefix apps\desktop run smoke
```

## Voice (Phase 5)

Push-to-talk above the message box: **Start speaking** opens the microphone (red *Microphone on* indicator, timer and
level meter, orb **Listening**); **Stop and transcribe** closes it. **Cancel** discards the recording. Capture also
stops at 60 s, when the device disappears, when the core goes offline and when the window closes or reloads. There is no
wake word and no background listening.

- **Recognition** is local: faster-whisper with the Whisper `base.en` model that must already be in the Hugging Face
  cache (`%USERPROFILE%\.cache\huggingface\hub`); AEGIS never downloads it (`local_files_only`, offline mode). The
  recording (16 kHz mono WAV) goes renderer → Electron main → core in memory and is discarded after transcription; no
  audio is written to disk or the database. Silence and unusable audio are reported as such, never guessed.
- **What happens to the transcript** is decided by fixed rules (no model call): ordinary questions are sent through the
  same routing as typed text (marked *spoken* in the conversation). `Remember …`, `Correct that memory: …`, low-confidence
  transcripts, spoken deletions and spoken approvals are shown for review first. Voice cannot approve a plan, run a tool or
  delete a memory; while a plan waits for approval the microphone is disabled.
- **Spoken corrections** resolve "that memory" to the one the conversation just used or saved (or ask you to choose),
  propose a new version that keeps your words verbatim, and are applied only when you click **Apply correction**. The
  old version stays in the memory history as superseded; provenance is `voice_command`.
- **Speech output** uses the Windows built-in voices (System.Speech through a fixed PowerShell script); the reply is
  played by the app, and the orb shows **Speaking** only while audio is actually playing. **Stop speaking** (or
  pressing **Start speaking** again) interrupts it; the composer's **Stop** still cancels a reply that is being
  generated, before anything is spoken. Only the first ~1200 characters are read.
- **Microphone permission**: Electron grants only microphone capture to the app page (camera and screen capture stay
  denied). Windows must also allow desktop apps to use the microphone (Settings → Privacy & security → Microphone);
  otherwise the app shows *Microphone access was denied*.

Fixture recordings for automated runs (synthetic speech from the local Windows voice, not microphone recordings):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-voice-fixtures.ps1 -OutDir $env:TEMP\aegis-voice
```

GUI acceptance through Chromium's fake capture device (one utterance per launch; reuse `AEGIS_SMOKE_USER_DATA` across
launches for remember → recall → correct → recall2):

```powershell
$env:AEGIS_SMOKE_VOICE_MODEL = 'llama3.2:3b'; $env:AEGIS_SMOKE_VOICE_SOURCE = 'fake'
$env:AEGIS_SMOKE_VOICE_STEP = 'ask'; $env:AEGIS_SMOKE_VOICE_WAV = "$env:TEMP\aegis-voice\ask.wav"
npm --prefix apps\desktop run smoke
```

`AEGIS_SMOKE_VOICE_SOURCE=human` records the real default microphone for `AEGIS_SMOKE_VOICE_SECONDS` (default 7) and
prints the phrase to say; `file` with `AEGIS_SMOKE_VOICE_FILE_DIR=<sample folder>` checks that a spoken file request
still stops at the trusted approval button.

## Troubleshooting

- **"The isolated browser could not start"** on a research task: run `scripts\setup.ps1` again
  (it installs the Chromium headless shell into the venv).

- **"Python environment not found"** in the status: run `scripts\setup.ps1`.
- **Port 5173 in use** (dev mode only): close the other Vite instance; the dev server will not pick another port.
