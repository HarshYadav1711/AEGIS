# ENGINEERING_LESSONS.md — Evidence-Calibrated Cross-Project Reuse Register
**Authority:** transfer architecture/test patterns, not proprietary code or unverified marketing. This is a summarized context map, not an independent rerun of every repository. Some entries are grounded in previous user discussions; verify source state at implementation time.

## 1. Agentic AI, GenAI and autonomy
| Project | Success / failure / learning | AEGIS implication |
|---|---|---|
| AHI | Evidence-led investigations, situation data, controlled representations, null/noise controls, fair baseline, uncertainty; research vision must not be presented as implemented | Investigation mode eventually, explicit facts/hypotheses, independent verification, frozen eval |
| RouteTune | BANKING77/Qwen QLoRA intent router experiment; CPU tests and starter tracked, later TRL BF16 trainable adapter incompatibility discovered; GPU/metrics must be checked from actual later artifacts | Route intent selectively; record precision/dtype, pinned deps, no claims about gains without logs |
| TaskWitness | Typed task spec, approve-once, journal, recovery/UNKNOWN, operator UI; adversarial status and control | Tool lifecycle and real action evidence, idempotent resume |
| RafterFlow | Deterministic booking facts/policies, bounded model use, Groq 429 retry, 129 pytest at reported milestone | Interpreter vs authority split, bounded retry, real tests |
| Candor/TextOS | BM25/hierarchical retrieval, source time and visibility, generalization regression/rejected phase, action dry-run | RAG evidence, abstention, hidden cases, constrain tool actions |
| VeyraQ/AIVOA | LangGraph intake, document relationships, corrections requiring review, CAPA | Staged changes and investigator agent; no employer implementation transfer |
| Pyrock | Durable Objects/Workers, workflow staging, `allowActions` flags | Read-first model plans; action flag policy; private code excluded |
| CometChat | Developer agent skills and UI/SDK workflows, multiple UID tests | Skill contracts, tool acceptance tests, permission awareness |
| CompassMind | Label corrections and uncertainty with temporal context | Contextual routing and evaluate confusion, don't overclaim |
| AI Finance Invoice & Forecasting | OCR→structured extraction→validation→approvals and audit | Future document specialist with deterministic checks |
| AI Code Review Bot & Codebase Explainer | Static analysis/citation-first developer reports | Read-only repo investigation with line/path evidence |
| GateMind/SignalLatch/ThetaLearn | Truth tables, anomaly suppression, state-aware questions | Deterministic action gate, no repeated unsupported recommendations |

## 2. Data, backend and systems
| Project | Success / failure / learning | AEGIS implication |
|---|---|---|
| Perzforge | Queued isolated jobs, replayable streaming logs, scoped tokens, quotas and Docker runners; more complex than MVP needs | Persist tasks/replay logs now; Redis/Docker isolation only for future untrusted code/workers |
| Aeryon | Wi-Fi CSI sensor events, Rust/C++/Python DSP, temporal features/replay and testable sensing pipeline; live hardware integration not blanket-complete | Typed event/perception schema, replay for multimodal inputs; don't drag CSI stack into MVP |
| Concuryx | Bounded vs burst scheduler, ordered reports, deterministic classifier, ~100 tests reported | Limit concurrency/tool rounds and stable reporting |
| Pactrieve | Doc ingestion, source offset/citation handling, Unicode marker bug and fix, streamed persistence/cancellation, access gate fix | Real source registry, strong parser, fail closed, no hidden citation repair |
| LedeSift | URL/redirect/DNS fetching constraints, Gemini live path, production release checks | No SSRF, test live keys outside mocks, deployment honesty |
| Kumi Labs | Microservice container integration complexity | Modular monolith, avoid service sprawl |
| Traceworks | Auth/refresh lifecycle and Postgres, cookie protections | Do not hand-roll crypto, protected backend secrets |
| LedgerPulse | Typed API, pagination, CSV, Postgres/Prisma | Clear services and export contracts |
| AgentWeave | Idempotent accounting keys | Every action has ID and durable terminal state |
| TaxWeave / CertGraph | Canonical synthetic data, graph relationships, manifest invariants | Consistent fixtures and evidence snapshots |
| CoreLoop | Time/resource limits not equivalent to secure sandbox | Never run arbitrary generated code with host Python |
| MeshVault/PressPilot | Scoped CRUD and real transaction lifecycle | Usable transaction over artificial feature count |

## 3. User experience and delivery
| Project | Success / failure / learning | AEGIS implication |
|---|---|---|
| Cybersecurity Research Desk | Governance and typography-first editorial style, no fake content, dependency discipline | Adopt project RULES, not UI/fonts/colors; orb is intentional user requirement |
| Axenloom | Undo/redo state, pointer real-device Gate B testing, interaction reducer | Orb/mouse controls verified against real Windows UI |
| VoiceUp / TARS | Realtime roles, status flows, chat and event state | Real task feed and persisted conversation |
| Quantus | Editor transaction, frontend state separation | Simpler state architecture, avoid oversized global store |
| Floneo | Evidence/approval/compliance entities and dashboards | Permission/evidence presentation, no fabricated audit status |
| News Automation / Ideaboat | Store original PDFs, page images and OCR evidence persistently locally | Provenance-aware file/document workflows |
| Local Connect | UI prototypes existed before functional backend | Explicitly distinguish designed and working features |
| React Native/Genesis | Mobile UI and actual Android testing constraints | Android companion later, device test required |
| Blender 3D internship | Scene complexity and FPS optimizations | Motion visual must stay cheap; hide/perf reduce when inactive |
| PeopleMesh / SylvanMind | Usable interfaces, privacy and rate limits | Practical flows, data minimization |
| LedeSift / Pactrieve release | Live deployment, env access gate, dev/prod parity | Real installation smoke before 'ready' claim |

## 4. Research/model/data discipline
Galaxy Morphology CNN, AMS-DCB, climate-risk and related ML work show the value of reproducible splits, baselines, calibration and limitations. Avoid gratuitous foundation-model training. Use RouteTune only after actual held-out comparison; do not conflate skill generation with model-weight training. AHI-inspired causal language is restricted without real causal identification.

## 5. Shared mandatory implementation practices
- Stable source-of-truth docs, phase context lock, GREEN/YELLOW/RED change governance.
- Independent output verification and negative/error evidence; real tool outcomes, not plausible model statements.
- Separate model interpretation from deterministic policy/calculation/authorization.
- Durable run IDs and cancel/unknown/reconcile states; retries only when safe.
- Threat-conscious yet feature-first: actual useful output then prioritized hardening.
- Don't overfit demos and test fixtures; keep held-out cases.
- No employer/client source/data/secret copy; attribution/permissions for external code.
- Never auto-commit, push or deploy; propose message and STOP.

## 6. Known knowledge limitations
Some historical statuses may have changed since the source summaries. RouteTune fine-tuning outcomes, Aeryon device integration and any per-project test numbers must be reverified from current artifacts before claimed externally. These lessons are for engineering decisions, not CV claims without evidence.
