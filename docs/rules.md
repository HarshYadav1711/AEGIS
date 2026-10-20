# rules.md — Binding AI / IDE Engineering Rules
**Project:** AEGIS. **Authority:** highest operational rule set; follow for Claude Code, Codex, Cursor and human edits. **Revision:** 1.0, 2026-10-21.

## 1. Mandatory context lock
Before edits read `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md` and the current phase prompt. Record branch/HEAD, dirty files, target phase, scope, exact authorized files, existing tests, unresolved decisions and expected deliverable. If starting in a directory containing unrelated work, STOP: never overwrite it.

## 2. Fixed product and priorities
AEGIS is a Windows-first real desktop AI assistant. Feature-first **with essential security at each boundary**. First deliver a launchable Electron window with original orb/real backend health, then real LLM chat, then a scoped file operation, then browser research and codebase inspection. Do not replace the product with a landing page, pure mock-up, multi-service backend or decorative orb demo.

## 3. Architecture lock
`Architecture.md` and `docs/DECISIONS.md` govern. Do not arbitrarily migrate framework, database, runtime, IPC design, orchestration, deployment platform or tool boundary. A change proposal needs exact reason, tradeoffs, required migration, impact, tests and approval **before** editing. Avoid unnecessary new microservices, Redis, Docker, Postgres, cloud infrastructure, packages or abstractions.

## 4. GREEN / YELLOW / RED
- GREEN: explicitly approved current-phase feature, local bug fix, necessary test, security validation within existing contracts.
- YELLOW: closely related refactor or dependency upgrade with explicit current-phase permission; justify/report it.
- RED: new architecture, framework, datastore, security trust boundary, model or paid provider, skill installation, UI system commitment, major scope expansion, remote network listener, new dependency outside phase preapproval. STOP for approval.

## 5. Design not locked
**Do not transplant the cybersecurity site's palette, fonts, or typography.** They are historical references only. Current locks are behavioral: interactive original orb; JARVIS holographic intelligence, ULTRON reactive energy, FRIDAY minimal voice patterns; accessible, functional state expression; modest runtime cost. Exact visual design, fonts, typography, color, spacing, motion style and layout remain open until Claude UI skills are inspected and a proposal approved. Do not install any new Claude skill without explicit approval. Do not copy movie assets, character likeness, voices, proprietary visual effects or Buildonaut UI code.

## 6. Build real functionality
No fake progress, results, security statistics, working controls, tool invocations, model completions or logged actions. Demo-only orb states must be plainly labeled as preview. Real states come from actual backend and mic/tool events. An error or unknown result remains error/unknown. No `try/except` that silently turns failure into success. Never silently switch from live model to mocked text.

## 7. Dependency, versions and finance
Prefer stable maintained licensed packages and lock resolved versions. npm only for JS (one package-lock); Python use a controlled environment and locked or recorded versions. Check compatibility before upgrades; never delete lockfiles to fix a failure. No required spending, payment card, paid API, mandatory cloud account, stealth external telemetry or ads. A free quota can change: document when live inference is unavailable, and offer local or explicitly opted-in alternative.

## 8. Safety, IP and privacy
No copied restricted Buildonaut/Brahma code. Respect third-party licenses; add attribution/NOTICE when applicable. Never reuse employer/client proprietary code or datasets without explicit permission. No secrets in renderer, logs, model context, tracked files, or example .env values. Whitelist tools and per-task scopes; model input/retrieved documents are untrusted. Refuse arbitrary shell execution/generated untrusted code until proper isolation exists. Mutations require user approval (file move with preview). Electron security defaults are mandatory. No remote listener unless specifically reviewed.

## 9. Minimal edge-case discipline
Prioritize core output and highest-risk defects (permission bypass, unintended writes, data loss, dangerous IPC, provider hallucinated success). Log low-risk UI polish/minor malformed inputs as backlog. Don't spend days on speculative attacks against unbuilt integrations. Do not ship a *known exploitable* privileged feature merely to maintain a deadline; defer that feature instead.

## 10. Code clarity & honest testing
Typed contracts; small cohesive functions; clear failure statuses and cancellation. Validate Pydantic backend models and TS IPC payloads; verify frontend/backend assumptions. Tests for current features only: unit/contract/E2E (manual evidence when automated desktop testing impractical). Test real provider separately from mock. Never report test pass without having run it. No invented benchmark numbers or future capability labels.

## 11. Git & phase discipline
Workflow: **READ → CONTEXT LOCK → PLAN CURRENT PHASE → IMPLEMENT → RUN CHECKS → REVIEW OUTPUT → REPORT → STOP**. Do NOT automatically commit, push, tag, deploy, continue phases or modify approved authority docs. At end provide changed files, commands/results, screenshots if possible, risks, backlog, exact next gate, and **one proposed Git commit message**. User manually commits.

## 12. UI/UX standards that remain mandatory
Keyboard access; focus states; reduced motion; accessible status alternatives to animated orb; responsible CPU/GPU; resilient loading/empty/error states. Avoid generic boilerplate, false UI affordances and oversized effects that hide useful tasks. Functional orb is required, visual aesthetics remain open.

## 13. Secrets and tooling
Do not print full secrets. Use host-side secure storage or an ignored local config, never frontend bundle. External websites and model outputs never become trusted tool policy. Do not authorize outgoing email, device, shell, clipboard extraction or filesystem deletes in MVP.

## 14. Research and attribution
Source registry must distinguish verified code evidence, repo README claims, videos, past-chat context and unverified assumptions. Prefer independently written code. For MIT/Apache/GPL or custom works, follow actual file-level licenses; attribution never overrides restrictive terms. README claims do not prove runtime function.

## 15. Completion checklist
The phase's honest end-to-end output works, error states are visible, baseline checks pass or explicitly blocked, no secrets are staged, no unauthorized out-of-scope modifications, proposed commit only, and progress is recorded in `docs/PROJECT_CONTEXT.md` after user-approved documentation update.
