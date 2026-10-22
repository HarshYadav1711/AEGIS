# SECURITY_REQUIREMENTS.md — Phase-Appropriate Security Baseline

## Phase 0
- Electron `contextIsolation: true`, sandbox true where supported, `nodeIntegration: false`, disable remote module, block unexpected navigation/window opens; CSP. Narrow preload, typed/sender-validated IPC; no insecure broad invoke channel.
- Python backend binds loopback only, rejects unauthorized requests, no LAN binding. Use a documented per-launch session authentication mechanism and lifecycle. Avoid logging session token.
- No default telemetry, remote scripts, hosted assets or secrets in renderer.

## Phase 1
- Model calls to local Ollama-style service use bounded timeouts; user explicitly selects remote providers and acknowledges external data handling.
- Reject unknown/malformed structured provider outputs. No hidden provider/model substitution. Secret values remain backend-side and gitignored; show a redacted config health view.
- Conversations have real session identity and visibility into failures/cancel events.

## Phase 2
- No delete, overwrite, unrestricted shell or generalized Python execution.
- Only operate on user-selected root; show exact planned moves and collision handling; require positive confirmation through trusted UI.
- Validate canonical paths and recheck at use; detect symlinks; fail conservatively on suspicious changes.
- Each move has stable operation ID, before/after manifest, verification and non-success state for ambiguity.

## Phases 3–4
- Browser public navigation is bounded and blocks internal/private/localhost/link-local destinations and unexpected redirects, with protections appropriate to browser request interception. Do not rely only on original URL checks.
- Untrusted web/document text cannot modify permissions, override the agent prompt hierarchy or instruct executor to bypass checks.
- Read-only repository walk excludes `.git`, `node_modules`, venv, binary blobs, secret files, oversized files and sensitive patterns. Never call shell for repo inspection.
- Phase 4 as implemented: repository root and report folder only from native pickers in main (no renderer path); the report folder may not be inside the repository; files opened read-only (`rb`) after a no-follow walk and an identity re-check; secret-pattern lines withheld from excerpts and never stored; repository text, memories and notes are quoted data for one tool-less model call; memory is retrieved only if current, and withheld if changed since the plan or contradicted by the manifests; vault excerpts need explicit per-task consent, a local model and an unchanged content hash, and never become memory or policy; nothing from a report is stored as memory without a user click.

## Workstream M0 — memory
- Capture only explicit `Remember …` messages, completed task outcomes and (as review-only candidates) model extraction of standing instructions; no screen, clipboard, keystroke, background-app or filesystem capture. A user toggle disables automatic capture.
- Model output can never make a memory current; status, scope, verification and provenance are set by deterministic code and database constraints.
- Refuse obvious secrets (keys, tokens, passwords, private keys); event log stores ids, not content. Delete removes every version.
- Retrieved notes are bounded, source-labelled, quoted data and never change tool access, approvals or policy. Memory stays local; it reaches only the user-selected local model.

## Workstream M0A — vaults
- Vault roots only from the native picker; must be an existing vault (`.obsidian/`) or an empty folder. Refuse links/junctions anywhere in the path, protected/system/app folders, drive roots and network paths; re-check root identity before every scan, open and write.
- Walk without following links; skip hidden/system entries, non-`.md`, oversize notes and secret-pattern notes; cap notes per vault.
- Existing vaults read-only; writes only by exclusive create inside an opted-in `AEGIS/` folder that must be an ordinary directory; read back and verify. No edit, rename, move or delete of notes.
- Vault text is untrusted data: never in model context, system instructions or policy in M0A; FTS5 query syntax neutralised; open-by-id with path re-validated in core and main.

## Phases 5–7
- Mic capture explicit and visible, no background recording by default; voice not high-risk approval.
- Phase 5 as implemented: Electron's permission handlers grant only audio `media` capture to the app page's main frame (camera, screen capture and everything else denied); capture runs only between the user's Start/Stop (indicator, timer, 60 s cap) and ends on Cancel, device loss, core loss and page teardown, with main cancelling pending voice jobs when the renderer reloads, crashes, closes or the app quits; recordings are validated (16 kHz mono PCM WAV, size) in main and core, decoded in memory and never stored or logged; speech recognition is local (faster-whisper, model from the local cache only, Hugging Face offline mode); transcripts take the same routing as typed text, memory commands are always shown for review, spoken approvals and deletions are refused, and the microphone is disabled while a plan waits for approval; a spoken memory correction is applied only by an explicit click, through the existing revision function, with `voice_command` provenance; TTS runs a fixed PowerShell script with the text as base64 on stdin and an allowlisted voice name.
- Agent delegation does not transfer wider authority. Check actual tool effect and audit history.
- Run small adversarial regression suite and dependency/secret scans; document residual risk.

## Future (not implemented)
Remote device mTLS, tool sandbox for generated code, signed updates, supply-chain attestations, security audits, safe physical-device interlocks. Do not claim complete protection merely because listed here.
