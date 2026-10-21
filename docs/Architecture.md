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

## ADR-011: Obsidian-compatible vaults (M0A) and the memory evidence model
**Authority.** A vault is a user-selected local folder of Markdown files. The *files* are the authority for note content; SQLite holds a derived, rebuildable FTS5 index plus AEGIS's own observation history (`vault_notes`, `vault_note_versions`, `vault_writes`). SQLite `memory_facts` stay the authority for AEGIS memory status. A note is evidence, never an automatic fact: no note becomes a memory or enters model context without a later, explicit, governed step.
**Provenance and identity.** Each note has a stable AEGIS id, its vault-relative path, the file identity (volume:file index, which follows renames) and, per observed content state, a version row with SHA-256, size, valid time (file modification time) and recorded time (when AEGIS observed it). Authorship comes only from AEGIS's own write records: a note counts as AEGIS-written only while it is byte-identical to what AEGIS wrote; any outside edit makes it the user's. Frontmatter cannot claim AEGIS authorship.
**Permissions.** Only folders chosen in the native picker are registered: an existing vault (has `.obsidian/`) or an empty folder (new AEGIS vault). Other folders (repositories, profile folders, the app data folder, system folders, network paths, links/junctions) are refused. Existing vaults are read-only; the user may allow exactly one write area, `<vault>/AEGIS/`. AEGIS only creates new files there (exclusive create, read-back verification) and never edits, renames, moves or deletes a note. No model or renderer input can name a path.
**Revision and synchronisation.** Re-scans are incremental (stat, then hash only changed files) and run on demand and before a search when the index is older than 10 s; no background watcher. Changes are recorded as `created`, `modified`, `renamed`, `deleted` or `restored` versions. Because AEGIS never writes to an existing file, an external edit can never be overwritten; a concurrent edit is simply the next observed version.
**Deletion.** A file deleted outside AEGIS is marked `deleted` (kept as history, removed from search). "Remove vault" deletes only the index and history, never a file.
**Privacy.** Hidden/system entries (`.obsidian`, `.git`, `.trash`), non-Markdown files, notes over 1 MB, vaults beyond 5000 notes and notes matching secret patterns are not indexed (secret notes keep only path and hash). Vault text is not sent to any model in M0A and has no authority over instructions, permissions or tools.
**Deferred AHI-inspired investigation (not implemented).** Future memory revision will link `memory_facts` to evidence by `vault_note_versions.id` (exact content state) with relations *supports / refutes*, add hypothesis records with explicit falsifiers and observed-vs-inferred labels, keep competing hypotheses side by side, and allow a memory status change only through a deterministic check plus user approval, with bounded evaluation fixtures. The M0A identity, version and time fields exist so this can be added without a schema rewrite. Workflow discovery and daily-context learning are later workstreams and need their own consent and security review.

## Critical boundary qualification
A Python in-process policy module and agent runtime are a boundary **against model-suggested unauthorized tool calls**, not against hostile Python executing with equal OS rights. Therefore disable arbitrary code, dynamic imports from model, unrestricted shells, untrusted plugins and permissive OS automation until robust OS isolation is built. This is part of the stable architecture, not an excuse to claim all future threats solved.

## Controlled future extension points
Vision (`PerceptionAdapter`), voice (`AudioAdapter`), tool queue (`TaskExecutor`), generated skill workers (`SkillRunner` isolated OS boundary), remote devices (`DeviceAdapter`), RouteTune router (`IntentAdapter`), AHI investigation (`InvestigationAdapter`). Add implementation behind interface after a working use case; no framework swaps.
