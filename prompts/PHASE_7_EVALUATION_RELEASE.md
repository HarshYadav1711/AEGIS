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
