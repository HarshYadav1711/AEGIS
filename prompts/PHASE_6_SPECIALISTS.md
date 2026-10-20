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
