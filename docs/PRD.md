# PRD.md — AEGIS Product Requirements Document
**Version:** 1.0 planning, 2026-10-21. **Status:** proposed; implementation not yet started.

## 1. Product thesis
A local-first Windows personal agent operating environment with a responsive central orb. Users can type or speak a goal, understand the plan, approve consequential actions, witness real execution and obtain a verified artifact or effect. The UI borrows **conceptual** cues from JARVIS (holographic intelligence), ULTRON (reactive energy), FRIDAY (minimal voice interaction), but all assets and code are original.

## 2. Target user and product surfaces
Initially a technical single-user Windows desktop. Electron UI contains interactive orb, conversation input/history, task progress, planned actions/approvals, outputs/evidence, settings for local/remote model adapter, and honest status/error surface. Optional always-on-top orb, Android, and smart-home support are post-MVP.

## 3. MVP outcome
**A.** Launch local Electron app and Python backend, see real availability, original state-linked orb (Phase 0). 
**B.** Enter real prompt, get streamed/reported answer from configured local Ollama-compatible model or user-selected truly free provider, persisted in SQLite (Phase 1). No simulated response masquerading as AI.
**C.** Ask assistant to organize files within a user-selected allowed folder using reviewable dry-run preview and verified actual file move (Phase 2).
**D.** Research limited allowlisted public web pages, cite sources and save an honest Markdown report in approved folder (Phase 3).
**E.** Analyze a selected local repository **read-only**, produce evidence-linked structure/risk report (Phase 4).
**F.** Push-to-talk voice and a small bounded Planner/Executor/Reviewer handoff (Phases 5-6). 
**G.** Reproducible smoke/eval and install/demo guide (Phase 7).

## 4. Core use cases and outputs
| ID | Request | Observable result | Hard safety condition |
|---|---|---|---|
| UC-01 | Talk to AEGIS | Provider-identified real answer, persisted message | No secret leakage; error on absent provider |
| UC-02 | Organize Downloads test folder | Preview + moved real files + resulting manifest | User-scoped root, no delete/overwrite/symlink escape |
| UC-03 | Research topic | Grounded report.md with visited source URLs | Controlled domains, no arbitrary remote posting |
| UC-04 | Explain repo | Report with real path/line support where feasible | Read-only workspace; ignore `.env`, credentials, node_modules |
| UC-05 | Speak a command | Speech transcript + authorized existing workflow | Mic permission and privacy indication; no voice-only high-risk approval |
| UC-06 | Delegate analysis | Specialist tasks and verified result statuses | Specialists never gain extra permissions |

## 5. Functional requirements
FR-01 Native Electron startup, readable responsive window; no dead controls. 
FR-02 Original interactive orb with Idle, Connecting, Listening, Thinking, Executing, WaitingApproval, Speaking, Succeeded, Error, Cancelled states; all real states driven by real events, preview mode explicitly labeled.
FR-03 Backend health/ready/status; backend lifecycle manages startup/shutdown; avoid open LAN listener.
FR-04 Pluggable local Ollama-compatible client and optional free hosted clients; explicit provenance/model identity.
FR-05 User-visible conversation history, cancellation, truthful provider errors and budget.
FR-06 Allowlisted typed tool registry, deterministic policy checks, per-task authorization.
FR-07 File organization with preview/approval and manifest verification; no deletion in MVP.
FR-08 Bounded Playwright public research; citations/source URLs, output report.
FR-09 Repository read-only analysis with sanitized/limited filesystem walk and source references.
FR-10 Later voice with push-to-talk; visible mic capture; interruption.
FR-11 Later specialist handoffs with explicit state machine and testable outcomes.
FR-12 Audit/event journal and meaningful negative/unknown statuses; no fake analytics.

## 6. Nonfunctional requirements
No mandatory paid tools or credit card; local-first; maintainable code; understandable from one demo; stable architecture; keyboard and reduced-motion support; sensitive-data privacy; no secrets in renderer; no untrusted code execution; no unverifiable claims; reproducible smoke tests; no auto commit/push/deploy.

## 7. Out of MVP but in long-term capability inventory
More sophisticated cross-app computer use, real-time interruptible voice, integrated email/calendar/message actions, Android pairing, smart-home, game/CAD/electronics design tools, genuine generated-skill forge (isolated), adaptive intent routing backed by measured RouteTune training, AHI-style hypothesis investigations, RAG semantic embeddings, scheduled jobs, deeper self-repair and remote access. Each addition requires security gate and real test.

## 8. Product success criteria
For each of three primary workflows demonstrate input, model/plan, policy decision, actual action/read, artifact, evidence and clear failure mode. Initial metrics are recorded rather than invented: task success, authorization bypasses observed, output validity, latency, tokens/provider, memory usage. 'Can do everything' is a roadmap objective, not an MVP claim.

## 9. IP and acknowledgments
Conceptual inspirations: Buildonaut's Brahma family, independently created JARVIS/ULTRON/FRIDAY projects, n8n and agentic AI educational work. No copied restricted implementation. Maintain a source/license register and acknowledgments. Employer/client implementations/data are off limits without permission.
