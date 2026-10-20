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
