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
