# AEGIS — Project Starter and Claude Build Kit

**Status:** Phase 0 implementation (bootable desktop shell + live backend status orb) awaiting user review. No AI chat yet. Setup and run instructions: [`DEVELOPMENT.md`](DEVELOPMENT.md).  
**Prepared:** 2026-10-21. **Mode:** feature-first, security alongside, honest evidence.  
**Name:** AEGIS is a working title. Brand/trademark clearance is not established.

## Start here

1. Create or choose a dedicated local project directory on Windows. Extract this package into its root.
2. Open that root in Claude Code (or another coding IDE), with access to the **existing user-installed UI/design skills**.
3. Read the five authoritative files **in order**: `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`. Also read `docs/DECISIONS.md` and `docs/PROJECT_CONTEXT.md`.
4. Give Claude **Phase 0 only** from `prompts/CLAUDE_PHASE_PROMPTS.md`. Review the result; manually commit after acceptance. Then move to Phase 1.
5. Do **not** paste private internship/client code, secrets, credentials or protected docs into this project.

## Why this package exists

Preserve the proven cybersec website's discipline (context lock, no arbitrary architecture changes, minimal diffs, free/stable dependencies, honest content, manual commits) while making a real Windows-first multimodal assistant with an **original** JARVIS-inspired holographic orb, ULTRON-inspired reactive energy and FRIDAY-inspired minimal voice interaction. Inspiration is visual/behavioral, not authorization to reuse copyrighted media or restrictive source.

## What is locked vs. deliberately open

**Locked:** Electron / React / TypeScript / Vite desktop, Python 3.12 / FastAPI modular backend, LangGraph when an actual tool workflow is needed, SQLite + FTS5, Playwright, model adapters, policy-gated allowlisted tools, npm + Python virtual environment, one monorepo, no mandatory paid/cloud services. 

**Open:** final orb styling, UI design system, fonts, type scale, palette, layout, animation aesthetics. Claude must first inventory existing UI skills and follow their instructions; installation of new skills/packages requires approval.

## Contents

- Five roots: `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`
- Cross-project engineering dossier: `docs/ENGINEERING_LESSONS.md`
- Authority/traceability: `docs/PROJECT_CONTEXT.md`, `docs/DECISIONS.md`, `docs/REQUIREMENTS_MATRIX.md`
- Security: `docs/THREAT_MODEL.md`, `docs/SECURITY_REQUIREMENTS.md`
- Evaluation/IP/provider: `docs/EVALUATION_PROTOCOL.md`, `docs/SOURCE_REGISTER.md`, `docs/ATTRIBUTION.md`, `docs/MODEL_PROVIDER_POLICY.md`
- Copy-paste implementation instructions and proposed commit messages: `prompts/CLAUDE_PHASE_PROMPTS.md`

## Development guardrails

- Do a **real vertical slice**, not fake working buttons or simulated LLM responses presented as live.
- No automatic `git commit`, `git push`, deployment, auto-install of extra skills or framework swaps.
- No generated code execution, unrestricted shell tools, arbitrary websites/network writes or device control in early releases.
- Run actual tests, report blockers, show verifiable outputs, distinguish `mock`, `local`, `remote`, `unavailable` and `replay`.
- Do not assume prior project architectures, failure fixes or license statuses are verified beyond supplied evidence.
