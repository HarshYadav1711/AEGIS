# phases.md — Feature-First Controlled Implementation Plan
**Version:** 1.0. **Instruction:** implement exactly one phase, verify, report and STOP. See `prompts/CLAUDE_PHASE_PROMPTS.md` for complete copy-ready prompts.

## Workflow for EVERY phase
READ five root authority docs + decisions/context → inspect Git working tree → implement only this phase → test real output → report exact evidence/blockers → provide proposed commit text → STOP. User reviews and commits manually.

| Phase | Target working output | Exit gate | Proposed commit message |
|---|---|---|---|
| **0 — Bootable shell** | Electron opens original idle/status orb; FastAPI `/health` live; secure IPC; SQLite can initialize | Desktop actually launches on Windows, main/renderer isolated, backend status accurate; no fake AI | `chore: bootstrap AEGIS desktop core and reactive orb` |
| **1 — Real AI conversation** | Locally configured LLM returns genuine answer in UI; messages persisted | Live successful Ollama-compatible call or honest blocked state, backend/provider errors visible | `feat: add real model-backed conversation and persistence` |
| **2 — First real agent** | Model-assisted files organize plan, user reviews, actual safe fixture files moved and verified | No out-of-root moves; approval gate, evidence, failure/unknown states | `feat: implement permissioned file organization agent` |
| **3 — Browser research** | Approved public pages fetched; source-grounded Markdown report generated | Actual URLs visited and report saved; unsafe/private destinations denied | `feat: add bounded browser research and grounded reports` |
| **4 — Codebase investigator** | Selected repository analyzed read-only; real findings report saved | Ignores secrets/dependency dirs; citations/path grounding; no repo modification | `feat: add read-only repository investigation workflow` |
| **5 — Voice interface** | Push-to-talk produces transcript; real voice action and audio state on orb | Mic capture visible and optional; speech/errors accurately represented | `feat: integrate push-to-talk voice with orb states` |
| **6 — Specialist agents** | Planner/Executor/Reviewer bounded delegation with persisted trace | Real scenario shows handoffs with no authority escalation; verifier not merely second-model approval | `feat: introduce bounded specialist agent coordination` |
| **7 — Demo/evaluation release** | Reproducible E2E demo, limits, model comparisons, package/readme | Measured results, real hardware smoke, install guide, failed cases; no inflated claims | `test: finalize AEGIS evaluation and MVP release evidence` |

## Start immediately
Phase 0 is both setup and real software: avoid a docs-only delivery. Existing authority docs are already authored in this pack, so Claude should validate/adapt only facts that conflict with the actual environment. **Do not rewrite authority files** during Phase 0 without approval.

## Later backlog (NOT implementation phases yet)
Cross-device Android, Home Assistant/IoT, proactive scheduling, workflow builder/n8n/MCP, multimodal screen vision, audio interruption, RAG embeddings, AHI-style investigation, RouteTune fine-tuned intent routing after verified results, secure Skill Forge with OS-isolated execution, full remote pairing and multi-user mode. Security controls required by these features must precede enabling them.

## Scope/edge-case rules
Each phase includes its own minimal authorization/error tests. Prioritize feature output, then highest-risk failure paths. Do not burn early releases on every hypothetical input or redesign. Deferred cases go to backlog with severity.
