# PROJECT_CONTEXT.md — Current AEGIS Context Lock
**Updated:** 2026-10-22 (user-approved status update after Phase 3). **Status:** Phases 0–2 committed; Phase 3 implemented and verified on this machine, **not yet committed** (awaiting user review).

## Goal
Build AEGIS, a genuine Windows-first assistant with original reactive orb, actual model calls, safe file/browser/repo automation, clear approvals, durable state, evidence and measurable evaluation. Reference aesthetic: JARVIS holography + ULTRON energy reactivity + FRIDAY voice minimalism. No copying assets/code. Financial goal: $0 mandatory spend.

## User decisions
- Build feature-first with essential security alongside; functional vertical slices; iterate edge cases later when noncritical.
- Core architecture locked, avoid arbitrary rewrites. Implement only one phase per request, stop for user review; proposed commit message, no auto commits/pushes/deploy.
- Claude has user-installed UI/design skills. Verify actual skills at runtime. Do not lock typography, fonts, colors, general layout; orb behavior is required now.
- Reuse learnings from prior work, including AHI, RouteTune, Aeryon, Perzforge, cybersecurity site, TaskWitness, RafterFlow, Candor, Pactrieve, Concuryx, VeyraQ, Pyrock, LedeSift, Axenloom and many others. IP limits apply.

## Known work state
Observed on the user's Windows 11 machine (Node 24.19.0, Python 3.12.0, Ollama 0.40.6 with `qwen3:4b`, `llama3.2:3b` and others installed).

| Phase | State | Evidence |
|---|---|---|
| 0 — Bootable shell | Committed `9b8d75a` | Electron smoke checks pass (isolation, IPC rejection, token auth, offline/reconnect, reduced motion) |
| 1 — Real AI conversation | Committed `983d617` | Ollama chat + SQLite persistence; real-model smoke runs only when `AEGIS_SMOKE_CHAT_MODEL` is set |
| 2 — File agent | Committed `825baa7` | LangGraph plan → approve → move → verify; journal and recovery tests |
| 3 — Browser research | Implemented on top of `825baa7`, **uncommitted** | See below |

Phase 3 verification (2026-10-22):
- Baseline before edits: pytest 119 passed / 6 skipped; 22 TS tests; Electron smoke all PASS.
- After: pytest 194 passed / 9 skipped (the 3 new skips are opt-in live tests); 27 TS tests; typecheck, lint and Electron smoke PASS, including research IPC rejection and refusal of private/local URLs in the running app.
- Live public web (`AEGIS_LIVE_WEB=1`): docs.python.org fetched and extracted; localhost, 127.0.0.1, 192.168.1.1 and http:// refused. Live model (`qwen3:4b`): report generated, 5 findings supported by verbatim quotes, saved and hash-verified.
- GUI run of the real app (smoke harness, only the native folder dialog answered by the harness): plan shown before any read, local URL refused, pages read, report generated in ~46 s, saved to the chosen folder without overwrite, opened via the OS, private-only request refused without a task.
- Known issues: one intermittent `test_provider_failures` failure in ~8 full runs (not reproduced; suspected render timeout under load); quote/keyword checks can mark a misparaphrased claim as supported (observed once); Wikipedia blocks the client (HTTP 403, reported as blocked); only direct URLs, no web search; JavaScript-only pages and PDFs are not read.

Design (fonts, palette, layout) remains open per D09. Phase 4 has not started.

## Authority precedence
1. `rules.md` — operational constraints
2. `PRD.md` — user goals/scope
3. `Architecture.md` — core technical boundaries
4. `Design.md` — orb behavior and intentionally open visual decisions
5. `phases.md` — ordered phase gates
6. `docs/DECISIONS.md` — rationale and change log
7. Current user-approved instructions and phase scope; conflicts between docs/user instruction must be raised, not quietly patched.
8. Other docs — evidence, tests, security, source/IP.

## Future updates
Only update this context file on an authorized phase to record actual repo SHA, verified commands/results, implementation state, outstanding blockers and approved decision changes. Never mark future work complete based on a prompt or mock.
