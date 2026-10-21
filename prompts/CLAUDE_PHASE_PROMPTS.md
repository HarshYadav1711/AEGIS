# Copy-Ready Claude Code Build Prompts — AEGIS

**Usage:** Paste exactly ONE numbered phase below into Claude Code from the root of the extracted `AEGIS_Project_Starter` folder. Do not paste all phases at once. Review each phase, manually commit only after acceptance.


---

## Phase 0: Bootable Desktop Shell + Real Orb Status

```text
# Phase 0 — Bootable Desktop Shell + Real Orb Status

You are working on AEGIS on the user's Windows machine in Claude Code. You are NOT the project owner and may not unilaterally change approved architecture or design decisions.

FIRST: read in order `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md`, plus `docs/SECURITY_REQUIREMENTS.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/ATTRIBUTION.md` where relevant. Inspect current branch/HEAD, git status, files, runtimes and test baselines; present a concise CONTEXT LOCK (current phase, allowlisted scope, constraints, acceptance gate). Existing unrelated files and uncommitted changes are sacred. Do not invent passed tests. Use the installed Claude UI/design skills if applicable only after inventorying the actual installed skill list and reading the selected skill guidance; do not invent skill names. Never install an additional skill, add an unapproved service, change architecture or spend money without explicit approval.

For every phase: implement the specified smallest **real working** vertical slice, keep the app functional, add relevant deterministic and honest end-to-end checks, inspect actual failures rather than upgrading everything, and update only the factual implementation status in docs when authorized. Do not fabricate live model output, task progress, security metrics or product screenshots. Do NOT auto-commit, push, publish, deploy, tag or continue to the next phase. End with: (1) context baseline, (2) exact changes/files, (3) running behavior with evidence, (4) exact commands/tests and pass/fail/blocker, (5) security/IP checks, (6) deferred issues, (7) one proposed Git commit message, (8) STOP for review.

CURRENT PHASE DIRECTIVES:

GOAL: Deliver a *running* Windows Electron desktop app connected to a real Python FastAPI backend, with an original state-driven orb and a real backend connection indicator. This is NOT a documentation-only phase. The five authority docs already exist and should be used, not replaced by generic boilerplate.

1. Confirm exact repository root and installed Node/npm and Python versions; use stable compatible Node LTS and Python 3.12. Do not modify system environment without approval. If toolchain absent, report exact blocker with minimal commands.
2. Scaffold only necessary `apps/desktop`, `services/core`, `packages/contracts` (if needed now), `scripts`. Vite/React/TypeScript Electron main/preload/renderer, npm only, one lockfile. Python virtual environment with FastAPI/Pydantic and minimal deps. Keep code simple; skip Tailwind if it adds avoidable setup friction, since visual design is OPEN.
3. Electron security: no Node integration in renderer, context isolation, sandbox, constrained navigation, sender-validated typed preload operations. No generic `ipcRenderer.send` or unrestricted HTTP proxy. Start/stop backend from Electron main with explicit safe executable path; bind loopback only, reserve safe dynamic port, protected per-launch auth for backend API, and no credentials in renderer/logs. Choose the simplest mechanism consistent with Architecture.md; if technically blocked explain rather than disabling protections.
4. Backend: authenticated `GET /health` with true state and version (no fake model availability); initialize local SQLite app data path and a schema/version table using explicit migrations. Add graceful startup/shutdown. Don't add Redis/Docker/Postgres or Node server.
5. Add minimal functional UI shell: original SVG/CSS/Canvas orb (no borrowed Marvel or Buildonaut assets), minimal status label, user-visible backend connected/offline states and a disabled or clear 'Chat available in Phase 1' indication. Motion must reflect real backend events. `prefers-reduced-motion` alternative. Clicking orb may focus input, but must NOT falsely claim it recorded microphone or used a model. Any development state preview must be visibly labeled as demo.
6. BEFORE visual work, discover locally installed Claude UI skills and inspect relevant guidance. Keep final UI, fonts, typography, palette and orb styling OPEN. Use a temporary practical presentation only. Do not install extra skills without approval.
7. Add a start script with PowerShell-friendly instructions and a fresh-install README. At least backend health/auth smoke, TypeScript check, build/lint, one app startup verification (or explicitly manual Windows confirmation if unable to run GUI in environment), and connection-loss orb test. No unsupported security claims.

DO NOT: attempt real AI chat, voice, desktop control, browser actions, arbitrary shell tools, three.js effects, semantic search, external sign-ins or phase 1 tasks. Deliver first real app. Report exact install commands and paths. Proposed commit message is listed below; DO NOT RUN GIT COMMIT.

Proposed commit message (text only, NEVER execute commit):
`chore: bootstrap AEGIS desktop core and reactive orb`
```


---

## Phase 1: Real Model-Backed Chat

```text
# Phase 1 — Real Model-Backed Chat

You are working on AEGIS on the user's Windows machine in Claude Code. You are NOT the project owner and may not unilaterally change approved architecture or design decisions.

FIRST: read in order `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md`, plus `docs/SECURITY_REQUIREMENTS.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/ATTRIBUTION.md` where relevant. Inspect current branch/HEAD, git status, files, runtimes and test baselines; present a concise CONTEXT LOCK (current phase, allowlisted scope, constraints, acceptance gate). Existing unrelated files and uncommitted changes are sacred. Do not invent passed tests. Use the installed Claude UI/design skills if applicable only after inventorying the actual installed skill list and reading the selected skill guidance; do not invent skill names. Never install an additional skill, add an unapproved service, change architecture or spend money without explicit approval.

For every phase: implement the specified smallest **real working** vertical slice, keep the app functional, add relevant deterministic and honest end-to-end checks, inspect actual failures rather than upgrading everything, and update only the factual implementation status in docs when authorized. Do not fabricate live model output, task progress, security metrics or product screenshots. Do NOT auto-commit, push, publish, deploy, tag or continue to the next phase. End with: (1) context baseline, (2) exact changes/files, (3) running behavior with evidence, (4) exact commands/tests and pass/fail/blocker, (5) security/IP checks, (6) deferred issues, (7) one proposed Git commit message, (8) STOP for review.

CURRENT PHASE DIRECTIVES:

PRECONDITION: Phase 0 signed off and existing app healthy. GOAL: Send a typed prompt to an actual configured model and display its actual response, associated model/provider and saved conversation after restart.

1. Extend existing FastAPI backend `ModelAdapter`, explicit Ollama-compatible local provider first; optional user-authorized, currently free hosted adapter only if needed and approved. Inspect current local models/hardware and ask before downloading large model. Never assume an API key exists, never log it and never require payment/card.
2. Implement typed chat request/response and optional SSE streaming; message statuses pending/streaming/complete/failed/cancelled, event/DB records, bounded timeout/token parameters. Identify actual provider/model used. If no working local or selected free model, show a truthful setup/error screen; no hard-coded fabricated assistant answer, no auto fallback pretending success.
3. Connect real frontend input/history to protected main/preload API. Orb states: thinking only when request is live, speaking only when actual TTS exists (not yet), succeeded/error/cancelled based on terminal response. Show concise status/evidence and accessible text equivalent.
4. Minimal tests for adapter errors, schema validation, conversation persistence, cancellation and frontend request path. Real model smoke separately reported as PASS / FAIL / NOT CONFIGURED. Verify .env/git ignore and ensure provider credentials do not reach renderer.

DO NOT: install arbitrary AI libraries, implement tools yet, scrape web, invent voice recording or rewrite orb aesthetic. Add only current-phase functionality.

Proposed commit message (text only, NEVER execute commit):
`feat: add real model-backed conversation and persistence`
```


---

## Phase 2: Real, Permissioned File Organization Agent

```text
# Phase 2 — Real, Permissioned File Organization Agent

You are working on AEGIS on the user's Windows machine in Claude Code. You are NOT the project owner and may not unilaterally change approved architecture or design decisions.

FIRST: read in order `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md`, plus `docs/SECURITY_REQUIREMENTS.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/ATTRIBUTION.md` where relevant. Inspect current branch/HEAD, git status, files, runtimes and test baselines; present a concise CONTEXT LOCK (current phase, allowlisted scope, constraints, acceptance gate). Existing unrelated files and uncommitted changes are sacred. Do not invent passed tests. Use the installed Claude UI/design skills if applicable only after inventorying the actual installed skill list and reading the selected skill guidance; do not invent skill names. Never install an additional skill, add an unapproved service, change architecture or spend money without explicit approval.

For every phase: implement the specified smallest **real working** vertical slice, keep the app functional, add relevant deterministic and honest end-to-end checks, inspect actual failures rather than upgrading everything, and update only the factual implementation status in docs when authorized. Do not fabricate live model output, task progress, security metrics or product screenshots. Do NOT auto-commit, push, publish, deploy, tag or continue to the next phase. End with: (1) context baseline, (2) exact changes/files, (3) running behavior with evidence, (4) exact commands/tests and pass/fail/blocker, (5) security/IP checks, (6) deferred issues, (7) one proposed Git commit message, (8) STOP for review.

CURRENT PHASE DIRECTIVES:

PRECONDITION: Phase 1 accepted. GOAL: A real user instruction produces a typed, reviewable file-organizing PLAN and, after trusted approval, moves real files within an explicit selected test folder; verifies outcome and records evidence.

1. Implement LangGraph within already chosen orchestrator interface for request→plan→policy→approve→execute→verify→journal. Avoid multi-agent swarms. Use a predictable fallback deterministic classification when LLM plan invalid or unavailable, distinctly labeled; model does not control policies.
2. Typed tools only: list selected root, generate organization plan based on extension/type, approval, execute moves, verify manifest. Plan must show explicit source/dest; no delete, overwrite or moving folders outside approved root. Check canonical paths/symlinks and revalidate before use, handle collisions deterministically, reject attempts to read `.env` or protected files, don't accept tool commands from file contents.
3. Approval must originate from trusted Electron UI, bound to task ID and exact action list with expiry. Never trust LLM-provided `approved: true`. Journal states include proposed/awaiting_approval/executing/complete/partial/failed/unknown/cancelled, with stable operation IDs. Do not blindly retry unknown effects.
4. Update orb state on genuine plan/action/approval events. Show an actual preview and final before/after file manifest in task UI. Produce demonstrable fixture-folder move without damaging real user files.
5. Tests: allowlisted root actual move, rejection outside-root, symlink/overwrite/collision case, two approvals, cancellation, tampered proposal, prompt-injection filename. Run actual fixture end-to-end, show log/evidence.

DO NOT: unrestricted terminal, shell, package installs, arbitrary custom Python skills, global filesystem access, email automation or next-phase browser.

Proposed commit message (text only, NEVER execute commit):
`feat: implement permissioned file organization agent`
```


---

## Phase 3: Controlled Research-to-Report Agent

```text
# Phase 3 — Controlled Research-to-Report Agent

You are working on AEGIS on the user's Windows machine in Claude Code. You are NOT the project owner and may not unilaterally change approved architecture or design decisions.

FIRST: read in order `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md`, plus `docs/SECURITY_REQUIREMENTS.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/ATTRIBUTION.md` where relevant. Inspect current branch/HEAD, git status, files, runtimes and test baselines; present a concise CONTEXT LOCK (current phase, allowlisted scope, constraints, acceptance gate). Existing unrelated files and uncommitted changes are sacred. Do not invent passed tests. Use the installed Claude UI/design skills if applicable only after inventorying the actual installed skill list and reading the selected skill guidance; do not invent skill names. Never install an additional skill, add an unapproved service, change architecture or spend money without explicit approval.

For every phase: implement the specified smallest **real working** vertical slice, keep the app functional, add relevant deterministic and honest end-to-end checks, inspect actual failures rather than upgrading everything, and update only the factual implementation status in docs when authorized. Do not fabricate live model output, task progress, security metrics or product screenshots. Do NOT auto-commit, push, publish, deploy, tag or continue to the next phase. End with: (1) context baseline, (2) exact changes/files, (3) running behavior with evidence, (4) exact commands/tests and pass/fail/blocker, (5) security/IP checks, (6) deferred issues, (7) one proposed Git commit message, (8) STOP for review.

CURRENT PHASE DIRECTIVES:

PRECONDITION: real file workflow accepted. GOAL: User asks a research question, agent browses approved public sites using Playwright, generates a source-backed Markdown report, previews and saves it in a selected workspace.

1. Add typed `browser.read_public` tool through existing broker; Playwright isolated ephemeral profile, bounded page count/time/bytes, allowed HTTPS/public domains, redirect+DNS/IP validation (protect private/local network); no login, posting, download/executing webpage code or arbitrary remote actions. Clarify supported destinations and limitations rather than claiming universal safe browsing.
2. Preserve URL/title/retrieval timestamp/source excerpt for actual fetched pages. Treat page content as hostile data. The model synthesizes only from fetched material and must not treat embedded instructions as tool authorization. Display sources; don't claim every sentence is proven if it is inferential.
3. Add `Report` artifact with run ID, exact consulted sources, uncertainty and verification status. User approves folder; backend writes real `.md` file; UI shows real path/open action only when saved.
4. Test reproducible public sample page plus blocked localhost/private address/redirection where test environment allows; injection attempt in webpage fixture; unavailable network results in failure not fake source list.

DO NOT: add a web search service that requires card, remote crawler infrastructure, browser plugin marketplace, unrestricted websites or unrelated UI revamp.

Proposed commit message (text only, NEVER execute commit):
`feat: add bounded browser research and grounded reports`
```


---

## Phase 4: Read-Only Repository Investigator

```text
# Phase 4 — Read-Only Repository Investigator

You are working on AEGIS on the user's Windows machine in Claude Code. You are NOT the project owner and may not unilaterally change approved architecture or design decisions.

FIRST: read in order `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md`, plus `docs/SECURITY_REQUIREMENTS.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/ATTRIBUTION.md` where relevant. Inspect current branch/HEAD, git status, files, runtimes and test baselines; present a concise CONTEXT LOCK (current phase, allowlisted scope, constraints, acceptance gate). Existing unrelated files and uncommitted changes are sacred. Do not invent passed tests. Use the installed Claude UI/design skills if applicable only after inventorying the actual installed skill list and reading the selected skill guidance; do not invent skill names. Never install an additional skill, add an unapproved service, change architecture or spend money without explicit approval.

For every phase: implement the specified smallest **real working** vertical slice, keep the app functional, add relevant deterministic and honest end-to-end checks, inspect actual failures rather than upgrading everything, and update only the factual implementation status in docs when authorized. Do not fabricate live model output, task progress, security metrics or product screenshots. Do NOT auto-commit, push, publish, deploy, tag or continue to the next phase. End with: (1) context baseline, (2) exact changes/files, (3) running behavior with evidence, (4) exact commands/tests and pass/fail/blocker, (5) security/IP checks, (6) deferred issues, (7) one proposed Git commit message, (8) STOP for review.

CURRENT PHASE DIRECTIVES:

PRECONDITION: Phase 3 accepted. GOAL: Select a repository folder, inspect allowed real source files without modification, and generate a useful grounded architectural/quality report as an artifact.

1. Implement read-only repo adapter within approved user-selected root; cap file sizes/count; ignore `.git`, binaries, node_modules, dist/build, venv, `.env`, tokens, generated artifacts and suspicious symlinks; redact secret-looking values. Do not execute repo code, package scripts or shell commands.
2. Derive file tree, manifest/dependency relationships from actual allowed files. Have optional LLM generate architecture, risks, next improvements with path/line anchors where validated. Distinguish observed patterns from speculation and missing coverage. Avoid saying all files analyzed if limits excluded some.
3. Save Markdown report in approved output directory; verify saved artifact and ensure repository itself remained unchanged (manifest/hash/dirty worktree check where feasible).
4. Tests: frozen repo fixture, path exclusions, oversized files, secret redaction, content-based prompt injection, no source writes, invalid model response and unavailable LLM handling.

MEMORY/CONTEXT INTEGRATION (D24, user instruction 2026-10-22): this phase also retrieves current repository-scoped and global memories (never candidate/disputed/superseded/rejected, never as authorization), offers up to 3 relevant vault notes with exact version for explicit per-task consent (local model only, stale versions dropped), applies AHI-style evidence labels (confirmed deterministic check / likely issue / plausible concern / best practice / insufficient evidence, hypotheses with supporting and contradicting evidence and verification steps), records the verified outcome as an experience, and offers code-built memory proposals that are stored only on user action. Report functional and memory/context acceptance separately.

DO NOT: code changes, PRs, auto-commits, arbitrary script execution, dependency install, auto 'fix'.

Proposed commit message (text only, NEVER execute commit):
`feat: add read-only repository investigation workflow`
```


---

## Phase 5: Real Voice Interface

```text
# Phase 5 — Real Voice Interface

You are working on AEGIS on the user's Windows machine in Claude Code. You are NOT the project owner and may not unilaterally change approved architecture or design decisions.

FIRST: read in order `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md`, plus `docs/SECURITY_REQUIREMENTS.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/ATTRIBUTION.md` where relevant. Inspect current branch/HEAD, git status, files, runtimes and test baselines; present a concise CONTEXT LOCK (current phase, allowlisted scope, constraints, acceptance gate). Existing unrelated files and uncommitted changes are sacred. Do not invent passed tests. Use the installed Claude UI/design skills if applicable only after inventorying the actual installed skill list and reading the selected skill guidance; do not invent skill names. Never install an additional skill, add an unapproved service, change architecture or spend money without explicit approval.

For every phase: implement the specified smallest **real working** vertical slice, keep the app functional, add relevant deterministic and honest end-to-end checks, inspect actual failures rather than upgrading everything, and update only the factual implementation status in docs when authorized. Do not fabricate live model output, task progress, security metrics or product screenshots. Do NOT auto-commit, push, publish, deploy, tag or continue to the next phase. End with: (1) context baseline, (2) exact changes/files, (3) running behavior with evidence, (4) exact commands/tests and pass/fail/blocker, (5) security/IP checks, (6) deferred issues, (7) one proposed Git commit message, (8) STOP for review.

CURRENT PHASE DIRECTIVES:

PRECONDITION: repo investigator accepted. GOAL: A real user-recorded spoken instruction can be transcribed, displayed, passed to a previously working authorized task, and followed by optional local voice feedback. Orb must reflect real mic and playback events.

1. Begin with press-and-hold/push-to-talk, explicit OS microphone permission, visible capture indicator and safe STOP. Use supported local STT tool evaluated for hardware and license (faster-whisper or another suitable maintained free engine); don't require cloud or billing. If local speech is too slow, show honest constraints and request optional provider choice.
2. Use a built-in Windows TTS voice first if available and suitable; no copied Marvel actor voices, unlicensed voice clones or proprietary audio assets. Streaming interruption optional if affordable; don't fake lip sync or speaking state.
3. Wire actual audio energy levels/transcript/playing event to orb listening/thinking/speaking. Keep keyboard/text UI primary and working. Audio capture must not silently run in background. Respect reduced-motion.
4. Real microphone test on user's Windows machine, permission denial/unplug error and one actual spoken→authorized workflow scenario, with clearly reported test status.

DO NOT: full always-listening wake word, background surveillance, remote microphone transmission by default, visual redesign, or movie voice imitation.

Proposed commit message (text only, NEVER execute commit):
`feat: integrate push-to-talk voice with orb states`
```


---

## Phase 6: Bounded Planner / Executor / Reviewer

```text
# Phase 6 — Bounded Planner / Executor / Reviewer

You are working on AEGIS on the user's Windows machine in Claude Code. You are NOT the project owner and may not unilaterally change approved architecture or design decisions.

FIRST: read in order `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md`, plus `docs/SECURITY_REQUIREMENTS.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/ATTRIBUTION.md` where relevant. Inspect current branch/HEAD, git status, files, runtimes and test baselines; present a concise CONTEXT LOCK (current phase, allowlisted scope, constraints, acceptance gate). Existing unrelated files and uncommitted changes are sacred. Do not invent passed tests. Use the installed Claude UI/design skills if applicable only after inventorying the actual installed skill list and reading the selected skill guidance; do not invent skill names. Never install an additional skill, add an unapproved service, change architecture or spend money without explicit approval.

For every phase: implement the specified smallest **real working** vertical slice, keep the app functional, add relevant deterministic and honest end-to-end checks, inspect actual failures rather than upgrading everything, and update only the factual implementation status in docs when authorized. Do not fabricate live model output, task progress, security metrics or product screenshots. Do NOT auto-commit, push, publish, deploy, tag or continue to the next phase. End with: (1) context baseline, (2) exact changes/files, (3) running behavior with evidence, (4) exact commands/tests and pass/fail/blocker, (5) security/IP checks, (6) deferred issues, (7) one proposed Git commit message, (8) STOP for review.

CURRENT PHASE DIRECTIVES:

PRECONDITION: Phase 5 accepted. GOAL: demonstrate genuine structured multi-agent coordination on a current supported task without granting additional abilities or creating a swarm for its own sake.

1. Build three roles within existing LangGraph orchestrator and state store: Planner proposes typed plan; Executor invokes only current preapproved tools under policy; Reviewer checks deterministic evidence/constraints and reports status. Reuse same provider if running locally, avoid forcing 3 paid model calls. Reviewer LLM can critique but must not override independent checks.
2. Each agent receives minimal contextual data and tools; never inherit broad privileges. Add bounded rounds/token budgets and failure/cancellation state. Store real handoff events in SQLite. Orb reacts to task statuses, not internal fake persona animation.
3. Demo a concrete end-to-end multi-step scenario (e.g. repo inspection then report, or research+file saved) that produces a real artifact. Compare success/latency/tool count against single-agent baseline on same inputs. Never claim better unless measured.
4. Test unauthorized handoff attempt, malformed schema, injection from retrieved text, budget exhaustion, cancellation and unknown outcomes.

DO NOT: background self-improvement, self-edits, unsandboxed coding, additional model frameworks, new databases or wholesale orchestration rewrite.

Proposed commit message (text only, NEVER execute commit):
`feat: introduce bounded specialist agent coordination`
```


---

## Phase 7: Reproducible MVP Demo & Evidence

```text
# Phase 7 — Reproducible MVP Demo & Evidence

You are working on AEGIS on the user's Windows machine in Claude Code. You are NOT the project owner and may not unilaterally change approved architecture or design decisions.

FIRST: read in order `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md`, plus `docs/SECURITY_REQUIREMENTS.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/ATTRIBUTION.md` where relevant. Inspect current branch/HEAD, git status, files, runtimes and test baselines; present a concise CONTEXT LOCK (current phase, allowlisted scope, constraints, acceptance gate). Existing unrelated files and uncommitted changes are sacred. Do not invent passed tests. Use the installed Claude UI/design skills if applicable only after inventorying the actual installed skill list and reading the selected skill guidance; do not invent skill names. Never install an additional skill, add an unapproved service, change architecture or spend money without explicit approval.

For every phase: implement the specified smallest **real working** vertical slice, keep the app functional, add relevant deterministic and honest end-to-end checks, inspect actual failures rather than upgrading everything, and update only the factual implementation status in docs when authorized. Do not fabricate live model output, task progress, security metrics or product screenshots. Do NOT auto-commit, push, publish, deploy, tag or continue to the next phase. End with: (1) context baseline, (2) exact changes/files, (3) running behavior with evidence, (4) exact commands/tests and pass/fail/blocker, (5) security/IP checks, (6) deferred issues, (7) one proposed Git commit message, (8) STOP for review.

CURRENT PHASE DIRECTIVES:

PRECONDITION: Phase 6 accepted. GOAL: deliver an actually installable, honest Windows demo showcasing the working capabilities and remaining limitations.

1. Fresh-clone install instructions with exact verified Windows PowerShell commands, declared prerequisites and optional local model download size/hardware; no paid or credit-card dependencies.
2. Stable deterministic fixture cases + at least one actual end-to-end real provider case if configured; report PASS/FAIL/SKIP distinctly, preserve real output examples, latency/task success only from actual observations. Test native application start/exit, backend teardown, secure IPC, folder approval, bounded research, repo inspection, real mic if available and agents.
3. Run npm typecheck/lint/build; Python unit/integration; adversarial injection and path tests, secrets/dependency scan; real task verification and package/installer smoke where toolchain permits. If GUI cannot run in execution environment, require user's manual gate before declaring done.
4. README feature matrix marking implemented/tested/verified/deferred, screenshots only of real app, honest setup and troubleshooting, risk register and third-party notices. Revisit branding only if requested. No release/tag/deploy/upload unless explicitly authorized.
5. Produce short real demo script with exact click sequence and recorded actions, not invented screenshots or output. State any unpaid provider quota, hardware limits or vulnerabilities candidly.

DO NOT: add a new feature to inflate demo, refactor architecture, install unreviewed skills, fake passing checks, auto-commit/push/deploy.

Proposed commit message (text only, NEVER execute commit):
`test: finalize AEGIS evaluation and MVP release evidence`
```
