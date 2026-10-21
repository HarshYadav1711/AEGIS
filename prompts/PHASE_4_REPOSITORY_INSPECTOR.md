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
