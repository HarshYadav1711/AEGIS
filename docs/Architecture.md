# Architecture.md — AEGIS Stable Architecture Record
**Version:** 1.0. **Decision status:** locked core architecture; selected optional modules deferred. **Platform:** Windows-first.

## ADR-001: One local monorepo / modular backend
```
apps/desktop/         Electron main + preload + React/TypeScript/Vite renderer
services/core/        Python 3.12 FastAPI app, Pydantic contracts
  app/models/         Local/hosted provider adapters
  app/agents/         Agent and later LangGraph state
  app/tools/          Registered typed tools, policy, implementations
  app/tasks/          Durable states, journal, cancel, verification
  app/memory/         SQLite/FTS5 schema and repository
  app/api/            Health, chat, tasks, approvals, events
  tests/              Pytest
packages/contracts/   Shared protocol schemas/examples, mirrored TS types
scripts/              Windows dev orchestration, checks
```
Only create directories when required for the current feature. No TypeScript backend duplicate; no Next.js, Redis, Docker, PostgreSQL, Rust, cloud services or microservices for MVP.

## ADR-002: IPC and startup
Electron **main** launches a known packaged/local Python executable with an explicit path (development uses user-installed venv), binds FastAPI only to `127.0.0.1` on a dynamically assigned port, passes short-lived startup session credentials through a protected startup channel (never argv/log/renderer). Renderer cannot use Node APIs. Secure context-isolated preload permits **narrow typed IPC**. Main proxies allowed HTTP/SSE calls to backend, authenticated with per-launch secret or equivalent protected transport; renderer never sees backend credential. Validate IPC senders and reject navigation/new windows outside allowlist. Document and test local process ownership and refusal of unauthenticated requests. Prevent elevation, network binding or arbitrary executable paths.

## ADR-003: Agent lifecycle
First use a simple bounded tool loop for basic chat if LangGraph complexity is not needed for Phase 1; transition within same planned backend `agents/` interface to **LangGraph** for plan→approve→act→verify when the first effectful workflow arrives. No competing orchestration framework and no architecture change. Agent can only return typed action proposals, never direct OS calls. Policies are deterministic. Initial tool registry is allowlisted and cannot load arbitrary code.

## ADR-004: Data
SQLite + WAL and FTS5. Local DB for conversations, task IDs, messages, action proposals, approvals, execution states, sources, evidence, logs. File contents themselves remain in approved user folder except selected document metadata. Migrations run explicitly with schema versioning, no unbounded raw logs, basic retention/privacy controls. No vector DB until measured need.

## ADR-005: Model adapters
`ModelAdapter` typed protocol: health, capabilities (text/vision/tools where supported), generate or stream with consistent message/result metadata. Default Ollama-compatible loopback API; remote adapters opt in only (Gemini/Groq/OpenRouter as available and permitted), no assumed perpetual free quota. Clear provider errors; no silent fallback or provider switching. Structured action validation server-side; invalid output yields a recoverable error or clarification. Never send user files to remote provider without explicit selection and warning.

## ADR-006: Orb/UI
Core orb implemented with original Canvas/SVG/CSS and app state binding, not movie footage or borrowed assets. Real states originate from backend/session/mic/action events; preview/demo mode visibly distinguished. Responsive, reduced-motion alternative, CPU-aware. **UI/font/typography/color palette/layout are OPEN**, Claude available UI skills guide proposal; skill installation is a RED change. Three.js/WebGL requires measured justification and permission.

## ADR-007: Tools and safety
`ToolSpec{id, input_schema, scope, side_effect, timeout, verification}`; controller `propose→validate→policy→(approval)→execute→verify→journal`. Initial actions `files.list`, `files.plan_organize`, `files.move_approved`, `browser.read_public`, `repo.inspect_read_only`. For filesystem use user-chosen root, canonical target checks and operating-system file handle/recheck to mitigate symlinks/TOCTOU; deny delete, overwrite and out-of-root operations. No shell tool exposed; no generated skill execution. Backend is NOT a hostile-code sandbox. Tool registry cannot be modified by model output.

## ADR-008: Browser/research
Isolated Playwright browser context, private profile, bounded navigation and response size; block private/loopback/link-local target addresses and unsafe redirects for arbitrary user URLs, approve domains where appropriate, separate public-source text from tool instructions. Saved report citations are URLs actually fetched, not hallucinated. Do not allow untrusted pages to initiate filesystem mutations.

## ADR-009: Secrets
OS keychain or local protected backend-side storage after implementation review; temporary development `.env.local` ignored by git, with user-provided keys and clear danger note; never renderer env prefix, packaged frontend secret, audit payload or model context. No hidden remote telemetry. Use free or local first.

## ADR-010: Testing/deployment
npm scripts for frontend lint/typecheck/build; Pytest for core and contracts; one deterministic end-to-end actual file move in fixture directory, one real model smoke only if configured (otherwise SKIPPED not PASSED), optional Playwright tests. Windows PowerShell developer setup. Do not auto-deploy/push/commit; manual packaging later.

## Critical boundary qualification
A Python in-process policy module and agent runtime are a boundary **against model-suggested unauthorized tool calls**, not against hostile Python executing with equal OS rights. Therefore disable arbitrary code, dynamic imports from model, unrestricted shells, untrusted plugins and permissive OS automation until robust OS isolation is built. This is part of the stable architecture, not an excuse to claim all future threats solved.

## Controlled future extension points
Vision (`PerceptionAdapter`), voice (`AudioAdapter`), tool queue (`TaskExecutor`), generated skill workers (`SkillRunner` isolated OS boundary), remote devices (`DeviceAdapter`), RouteTune router (`IntentAdapter`), AHI investigation (`InvestigationAdapter`). Add implementation behind interface after a working use case; no framework swaps.
