# PROJECT_CONTEXT.md — Current AEGIS Context Lock
**Updated:** 2026-10-22 (user-approved roadmap change: integrated memory development, D24). **Status:** Phases 0–3, M0 and M0A committed (HEAD `24fc13a`). Phase 4 not started.

## Goal
Build AEGIS, a genuine Windows-first assistant with original reactive orb, actual model calls, safe file/browser/repo automation, clear approvals, durable state, evidence and measurable evaluation. Reference aesthetic: JARVIS holography + ULTRON energy reactivity + FRIDAY voice minimalism. No copying assets/code. Financial goal: $0 mandatory spend.

## User decisions
- Build feature-first with essential security alongside; functional vertical slices; iterate edge cases later when noncritical.
- Core architecture locked, avoid arbitrary rewrites. Implement only one phase per request, stop for user review; proposed commit message, no auto commits/pushes/deploy.
- Claude has user-installed UI/design skills. Verify actual skills at runtime. Do not lock typography, fonts, colors, general layout; orb behavior is required now.
- Memory is developed inside each product phase (D24, `phases.md` "Integrated memory development"), not as separate milestones; each phase reports functional and memory/context acceptance separately. Nothing beyond M0/M0A memory is implemented yet.
- Reuse learnings from prior work, including AHI, RouteTune, Aeryon, Perzforge, cybersecurity site, TaskWitness, RafterFlow, Candor, Pactrieve, Concuryx, VeyraQ, Pyrock, LedeSift, Axenloom and many others. IP limits apply.

## Known work state
Observed on the user's Windows 11 machine (Node 24.19.0, Python 3.12.0, Ollama 0.40.6 with `qwen3:4b`, `llama3.2:3b` and others installed).

| Phase | State | Evidence |
|---|---|---|
| 0 — Bootable shell | Committed `9b8d75a` | Electron smoke checks pass (isolation, IPC rejection, token auth, offline/reconnect, reduced motion) |
| 1 — Real AI conversation | Committed `983d617` | Ollama chat + SQLite persistence; real-model smoke runs only when `AEGIS_SMOKE_CHAT_MODEL` is set |
| 2 — File agent | Committed `825baa7` | LangGraph plan → approve → move → verify; journal and recovery tests |
| 3 — Browser research | Committed `2440179` | See below |
| M0 — Adaptive memory | Committed `e71de65` | See below |
| M0A — Vault indexing | Committed `24fc13a` | See below |

Phase 3 verification (2026-10-22):
- Baseline before edits: pytest 119 passed / 6 skipped; 22 TS tests; Electron smoke all PASS.
- After: pytest 194 passed / 9 skipped (the 3 new skips are opt-in live tests); 27 TS tests; typecheck, lint and Electron smoke PASS, including research IPC rejection and refusal of private/local URLs in the running app.
- Live public web (`AEGIS_LIVE_WEB=1`): docs.python.org fetched and extracted; localhost, 127.0.0.1, 192.168.1.1 and http:// refused. Live model (`qwen3:4b`): report generated, 5 findings supported by verbatim quotes, saved and hash-verified.
- GUI run of the real app (smoke harness, only the native folder dialog answered by the harness): plan shown before any read, local URL refused, pages read, report generated in ~46 s, saved to the chosen folder without overwrite, opened via the OS, private-only request refused without a task.
- Known issues: one intermittent `test_provider_failures` failure in ~8 full runs (not reproduced; suspected render timeout under load); quote/keyword checks can mark a misparaphrased claim as supported (observed once); Wikipedia blocks the client (HTTP 403, reported as blocked); only direct URLs, no web search; JavaScript-only pages and PDFs are not read.

M0 verification (2026-10-22):
- Baseline before edits: pytest 194 passed / 9 skipped; 27 TS tests; Electron smoke PASS.
- After: pytest 223 passed / 11 skipped (2 new opt-in live tests); 30 TS tests; typecheck, lint and Electron smoke PASS (incl. memory IPC rejection and secret refusal in the running app).
- Live `qwen3:4b`: extraction returned schema-valid candidates (~5 s); remember → core restart → recall `Zephyr-42` → correction → recall `Orion-7` only.
- Windows GUI (smoke harness, real model, real UI clicks): same scenario with a core process restart, and again split across two full app launches sharing one profile; all checks PASS.
- Known limits: lexical FTS5 retrieval (no synonyms); conflict detection only by identical subject label; `Remember …` messages are stored verbatim (kind/subject by regex); deleting a memory does not delete the chat message it came from; single user, project scope is a manual label.

M0A verification (2026-10-22):
- Baseline before edits: pytest 223 passed / 11 skipped; 30 TS tests.
- After: pytest 236 passed / 11 skipped; 33 TS tests; typecheck and lint PASS.
- Windows GUI acceptance (smoke harness; native folder dialog answered by the harness, external open recorded instead of launched): empty folder → new vault → note created in `AEGIS/` → search → file edited outside AEGIS → re-index (1 changed) → search shows new text, labelled as the user's note v2, old text gone. PASS.
- Obsidian app and `obsidian` CLI are NOT installed on this machine; compatibility rests on Markdown/frontmatter/wikilink parsing only.
- Environment note: the existing smoke check "full motion animates the orb" failed intermittently in this session on the committed baseline too (window not painted while covered); not caused by M0A.

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
