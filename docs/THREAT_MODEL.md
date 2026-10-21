# THREAT_MODEL.md — MVP Trust Boundaries
**Scope:** phases 0–4 (Phase 4 rows added 2026-10-22); update when new capabilities shipped. Security claims require explicit tests.

## Trust actors
User / Electron renderer (may display untrusted content) / Electron main & narrow preload / loopback Python core (same Windows user) / model provider & model outputs (untrusted) / external sites and documents (untrusted) / tool registry (trusted project code) / selected local workspace / SQLite state.

## Important limitation
The Python core runs with user privileges. App-level tool checks guard the **LLM's accessible capabilities**; they do NOT make arbitrary Python imports/processes safe. No shell execution, generated untrusted code, dynamic model-controlled modules or unrestricted third-party plugins in MVP. Later expansion requires OS-level isolation.

## Main boundaries and defenses
| ID | Entry/path | Threat | Baseline defense | Acceptance test |
|---|---|---|---|---|
| T01 | Renderer→main | Renderer invokes OS/network powers | nodeIntegration off, contextIsolation/sandbox on, strict IPC, validated sender | Unknown channels rejected |
| T02 | Main→backend | Other local app calls open endpoint | loopback only, per-launch auth and origin / ownership checks | Unauthenticated calls rejected |
| T03 | Untrusted text→agent | Prompt injection claims tool authority | Treat content as data; broker owns decisions | Document instruction cannot move/delete files |
| T04 | Agent→tools | Out-of-scope mutation | Explicit allowlist, scoped approval, typed args | Denied action has no side effects |
| T05 | File path→disk | Traversal/symlink/overwrite | Root scoping, path/handle verification, no overwrite/delete | Escape and overwrite denied |
| T06 | Provider→confidential data | Secrets/file content sent remotely | Opt-in external models, redaction and clear permission | No implicit upload of local files |
| T07 | Browser→network | SSRF/local network access, hostile redirects | Public-origin allowlist, DNS/IP checks, redirect recheck; conservative Playwright network rules | Internal destinations denied |
| T08 | Planner→result | Hallucinated action success | Evidence verifier and journal | No success before effect observed |
| T09 | Interrupt→recovery | Duplicate irreversible action | Operation IDs, explicit reconcile, no blind retry | Interrupted action stays unknown until checked |
| T10 | SQLite→privacy | Sensitive logging/state leakage | Scoped local storage, retention, secret exclusion | Secret absent from DB/log fixtures |
| T11 | Packages→supply chain | Malicious dependency/skills | Maintained stable licensed deps, review before adding | No unauthorized package install |
| T13 | Memory→model context | Stored or model-proposed text acts as instructions, fake provenance, secret retention | Proposals stay `candidate` until user confirms (DB CHECK); immutable versions; notes JSON-quoted on one line under a data-only header; secret patterns refused; memory not read by file/research policy | `tests/test_memory.py` injection, secret, candidate and scope tests |
| T14 | Vault→core / model | Path escape via links, overwrite of personal notes, spoofed authorship, injected instructions, secret indexing | Picker-only roots, no-follow walk, scope re-check, create-only `AEGIS/` area, authorship from write records, no vault text to models, secret skip | `tests/test_vaults.py` junction, read-only, spoofing, injection, secret tests |
| T15 | Repository→core / model (Phase 4) | Repo writes, link escape, secret leakage into context/DB/report, injected instructions in code or notes, stale memory or notes treated as truth, report written into the repo | Picker-only root (scope checks), no-follow walk + identity re-check on open, read-only `rb` opens, no execution; sensitive files listed by path only; secret-pattern lines withheld; code and notes fenced as data with injection flag; one model call, no tools; memories re-checked and contradiction-checked, vault notes only with explicit consent, local model and unchanged hash; save folder outside the repo; stat snapshot re-compared | `tests/test_repo.py` exclusion, junction, read-only digest, injection, secret, consent, stale-note, stale-memory and save tests; Electron smoke repo IPC rejection |
| T12 | Orb→user interpretation | Fake progress or mic recording | Backend state binding and explicit capture status | Preview labeled; mic indicator honest |

## Highest severity blockers
Any privilege/authorization bypass; arbitrary generated-code execution; automatic destructive host operations; renderer node injection; unsafe remote listener; silent access to confidential documents; prompt injection causing mutation without approval. Block these features until tested.

## Deferred risk register
Sophisticated remote pairing, TLS/mTLS, external audit anchors, update signing, connector OAuth, code sandbox breakout, device control. Deferred because not in enabled MVP. Do not claim mitigated.
