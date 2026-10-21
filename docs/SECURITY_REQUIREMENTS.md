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

## Workstream M0 — memory
- Capture only explicit `Remember …` messages, completed task outcomes and (as review-only candidates) model extraction of standing instructions; no screen, clipboard, keystroke, background-app or filesystem capture. A user toggle disables automatic capture.
- Model output can never make a memory current; status, scope, verification and provenance are set by deterministic code and database constraints.
- Refuse obvious secrets (keys, tokens, passwords, private keys); event log stores ids, not content. Delete removes every version.
- Retrieved notes are bounded, source-labelled, quoted data and never change tool access, approvals or policy. Memory stays local; it reaches only the user-selected local model.

## Phases 5–7
- Mic capture explicit and visible, no background recording by default; voice not high-risk approval.
- Agent delegation does not transfer wider authority. Check actual tool effect and audit history.
- Run small adversarial regression suite and dependency/secret scans; document residual risk.

## Future (not implemented)
Remote device mTLS, tool sandbox for generated code, signed updates, supply-chain attestations, security audits, safe physical-device interlocks. Do not claim complete protection merely because listed here.
