# REQUIREMENTS_MATRIX.md — Feature Traceability
**All rows are PLANNED unless independently verified after real implementation.**

| Req | Feature | Priority | Phase | Source/concept | Acceptance proof |
|---|---|---|---|---|---|
| R001 | Native startup / real backend status | P0 | 0 | Product | Electron launches, `/health` responds, loss is shown as offline |
| R002 | Original reactive orb | P0 | 0 | JARVIS/ULTRON/FRIDAY direction | Real health-state animation; reduced-motion fallback |
| R003 | Secure main/preload boundary | P0 | 0 | Electron hardening | No Node in renderer, IPC narrow, origin checks |
| R004 | SQLite initialization | P0 | 0 | Local first | New installation creates scoped local DB |
| R005 | Genuine Ollama-compatible chat | P0 | 1 | GenAI | Non-empty real model answer or truthful connection error |
| R006 | Provider boundary, identity, stream errors | P0 | 1 | RouteTune/RafterFlow | Correct model metadata and bounded retry |
| R007 | Persisted chat history | P0 | 1 | Pactrieve | Restart retains messages, no secrets logged |
| R008 | Tool proposal and permission gate | P0 | 2 | TaskWitness/Pyrock | Rejected actions produce no mutation |
| R009 | Scoped file organization | P0 | 2 | Buildonaut features | Real file moves, preview, manifest and final verification |
| R010 | Approved browser research | P0 | 3 | Buildonaut/Cole Medin | Real fetched source URLs and saved report — **IMPLEMENTED, TESTED, VERIFIED (2026-10-22, committed `2440179`)**: deterministic fixture suite + live docs.python.org fetch + real `qwen3:4b` report saved and hash-checked in the Windows app; private/local URLs refused. Limits: direct URLs only (no search), JS-off rendering, lexical citation checks |
| R023 | Adaptive memory M0 (provenance, corrections, scoped retrieval) | P1 | M0 | Pactrieve/Candor/TaskWitness | **IMPLEMENTED, TESTED, VERIFIED (2026-10-22, committed `e71de65`)**: 29 deterministic tests; live `qwen3:4b` extraction + remember→restart→recall→correct→recall; Windows GUI smoke (core restart and full app restart). Limits: lexical FTS5 retrieval only, subject-based conflict detection, single user |
| R024 | Obsidian-compatible vault indexing M0A | P1 | M0A | kepano/obsidian-skills, Thinkers Club vault articles | **IMPLEMENTED, TESTED (2026-10-22, committed `24fc13a`)**: 13 deterministic tests on real folders incl. junctions; Windows GUI acceptance (create → index → search → external edit → re-index → verify) PASS. Obsidian app and CLI NOT installed, NOT tested |
| R025 | AHI-inspired memory investigation (evidence links, hypotheses, falsifiers, temporal validity, negative results, governed revision) | P2 | incremental, 4+ (D24) | AHI | PARTIAL (Phase 4): evidence levels (deterministic pattern detected / likely / plausible / practice / insufficient, plus a lexical support level per checked model finding: supported narrow observation vs. requires review; a matching quote is not treated as claim verification), hypotheses with supporting + contradicting evidence and verification steps, exact vault-note versions per task, deterministic stale/contradiction checks for memory. Not yet: `supports/refutes` links in `memory_facts`, falsifier records, governed status change from a check |
| R026 | Adaptive workflow discovery (authorized AEGIS actions only, proposed not auto-run) / daily-context learning | P2 | incremental, 4+ (D24); daily-context: future | AHI/RouteTune | PLANNED; daily-context learning requires consent and security review |
| R027 | Per-phase memory/context integration (retrieval, verified outcome capture, provenance, stale/conflict detection, corrections, privacy) | P1 | 4–7 (D24) | Directive 2026-10-22 | Phase 4 IMPLEMENTED, TESTED, VERIFIED (2026-10-22): repo-scoped + global retrieval, rejected/superseded/changed/contradicted memories withheld, consented vault excerpts at exact version (stale dropped, local model only), verified experience on save, proposals stored only on user click. Phase 5 IMPLEMENTED, TESTED, VERIFIED (2026-10-22): spoken remember (reviewed, spoken provenance), recall through normal retrieval, spoken correction resolved to the conversation's memory and applied as a new version (`voice_command`), conflict/temporary/exception/low-confidence classification, voice cannot delete or approve. Phases 6–7 PLANNED |
| R011 | Read-only codebase investigation | P0 | 4 | Candor/Codebase Explainer | **IMPLEMENTED, TESTED, VERIFIED (2026-10-22, uncommitted)**: 19 deterministic tests on disposable repos (exclusions, junctions, read-only digest, injection, secrets, cancellation, save outside repo); live `qwen3:4b` report on a fixture; Windows GUI acceptance on a sample repo (report saved and hash-checked, every repo file unchanged). Limits: lexical checks, Python/relative-JS import graph only, 12 excerpts to the model, evidence check proves quotes exist, not that they prove a claim |
| R012 | Push-to-talk voice / orb | P1 | 5 | FRIDAY | **IMPLEMENTED, TESTED, VERIFIED (2026-10-22, uncommitted)**: local faster-whisper base.en + Windows SAPI; orb listening/transcribing/thinking/responding/speaking/done/cancelled/error from real events with live levels; fixture-device GUI acceptance A/B/C and one real-microphone run with the user. Limits: English model, push-to-talk only, proper nouns, reply speech capped at ~1200 chars |
| R013 | Bounded specialist handoff | P1 | 6 | ULTRON/VeyraQ | Actual role transition, no privilege expansion |
| R014 | Measured eval and demo | P0 | 7 | Concuryx/AHI/RouteTune | Reproducible fixture runs, honest pass/fail report |
| R015 | Local document RAG | P2 | future | Pactrieve/Cole Medin | Citation validation/coverage and abstention |
| R016 | Voice interrupt and realtime multimodal | P2 | future | Real-time assistants | Real audio interrupt benchmark |
| R017 | Screen/visual perception | P2 | future | Brahma/FRIDAY/Aeryon | Opt-in screenshot and real action evidence |
| R018 | Authorized email/calendar/devices | P2 | future | Buildonaut/n8n | Scoped connector action & approval |
| R019 | Secure skill generation and execution | P2 | future | Brahma Evo inspiration | VM isolation, reviews and rollback |
| R020 | AHI-inspired investigative agent | P2 | future | AHI | Competing hypotheses/tool tests with source evidence |
| R021 | Fine-tuned RouteTune intent adapter | P2 | future | RouteTune | Verified training logs + fair held-out improvement |
| R022 | Android and IoT pairing | P2 | future | Buildonaut | Mutual auth, revocation and physical safety |

Do not mark any entry DONE based on a README, mocked E2E or screenshots only. State `DESIGNED`, `IMPLEMENTED`, `TESTED` and `VERIFIED` separately.
