# DECISIONS.md — Architecture and Product Decision Ledger
**Version 1.0, 2026-10-21**. These decisions govern implementation until a user-approved ADR change.

| ID | Decision | Why | Status |
|---|---|---|---|
| D01 | Feature-first + critical security in each feature | Avoid analysis paralysis while not shipping exposed operations | LOCKED |
| D02 | Windows-first Electron, React, TypeScript, Vite | Native desktop capabilities, familiar frontend stack | LOCKED |
| D03 | Python 3.12 FastAPI modular core | AI/ML ecosystem and existing engineering familiarity | LOCKED |
| D04 | LangGraph for actual multi-step execution from Phase 2 | Checkpointed agent orchestration, no agent-swarm spectacle | LOCKED design; implementation deferred |
| D05 | SQLite + WAL + FTS5 | Local first, no database server, compatible with single user | LOCKED |
| D06 | Playwright isolated context | Repeatable browser automation | LOCKED for Phase 3 |
| D07 | Ollama-compatible local primary; explicit free remote fallback | Zero required spend, provider independence | LOCKED interface, actual model selection verified in Phase 1 |
| D08 | Original orb required from first runtime | User wants JARVIS/ULTRON/FRIDAY inspired interactive center | LOCKED behavior |
| D09 | Exact fonts, typography, colors, layout and visual techniques undecided | Claude UI skills and user selection later | OPEN |
| D10 | User-installed Claude UI skills preferred | Reuse the user's own skills and check real availability | LOCKED procedure; skill list UNKNOWN |
| D11 | Additional skills/plugins/dependencies require approval | Supply-chain, security and scope | LOCKED |
| D12 | No dynamic model-generated code or unrestricted shell in MVP | In-process Python policy is not a code sandbox | LOCKED |
| D13 | Human approval for file changes and any consequential action | Least authority and real trace | LOCKED |
| D14 | No mandatory subscription/credit card/paid API | Product must run locally for free | LOCKED |
| D15 | Small phased increments with manual commits | Lessons from prior assignments and repo drift | LOCKED |
| D16 | Original code, proper source attribution, no private job/client code | IP compliance | LOCKED |
| D17 | No arbitrary framework/service swaps | Stable understandable architecture | LOCKED |
| D18 | Demo and benchmarks must show real outcomes with provenance | TaskWitness/Pactrieve/RouteTune/AHI lessons | LOCKED |
| D19 | Name AEGIS is provisional pending availability review | No trademark clearance | OPEN branding |
| D20 | Long-term Android/IoT, Skill Forge, smart-home, AHI/RouteTune integration deferred | Must build useful core before expansions | BACKLOG |

## Required architecture amendment process
Document actual failure/evidence → describe smallest viable fix under existing contract → compare alternative approaches → impact matrix (data/API/security/tests/UI) → user approval → update ADR + docs → implement narrowly. Do not swap architecture for aesthetics, novelty, tutorial pressure or a single package installation problem.
