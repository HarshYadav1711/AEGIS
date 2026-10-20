# Phase 5 — Real Voice Interface

You are working on AEGIS on the user's Windows machine in Claude Code. You are NOT the project owner and may not unilaterally change approved architecture or design decisions.

FIRST: read in order `rules.md`, `PRD.md`, `Architecture.md`, `Design.md`, `phases.md`, `docs/DECISIONS.md`, `docs/PROJECT_CONTEXT.md`, plus `docs/SECURITY_REQUIREMENTS.md`, `docs/EVALUATION_PROTOCOL.md`, `docs/REQUIREMENTS_MATRIX.md`, and `docs/ATTRIBUTION.md` where relevant. Inspect current branch/HEAD, git status, files, runtimes and test baselines; present a concise CONTEXT LOCK (current phase, allowlisted scope, constraints, acceptance gate). Existing unrelated files and uncommitted changes are sacred. Do not invent passed tests. Use the installed Claude UI/design skills if applicable only after inventorying the actual installed skill list and reading the selected skill guidance; do not invent skill names. Never install an additional skill, add an unapproved service, change architecture or spend money without explicit approval.

For every phase: implement the specified smallest **real working** vertical slice, keep the app functional, add relevant deterministic and honest end-to-end checks, inspect actual failures rather than upgrading everything, and update only the factual implementation status in docs when authorized. Do not fabricate live model output, task progress, security metrics or product screenshots. Do NOT auto-commit, push, publish, deploy, tag or continue to the next phase. End with: (1) context baseline, (2) exact changes/files, (3) running behavior with evidence, (4) exact commands/tests and pass/fail/blocker, (5) security/IP checks, (6) deferred issues, (7) one proposed Git commit message, (8) STOP for review.

CURRENT PHASE DIRECTIVES:

PRECONDITION: repo investigator accepted. GOAL: A real user-recorded spoken instruction can be transcribed, displayed, passed to a previously working authorized task, and followed by optional local voice feedback. Orb must reflect real mic and playback events.

1. Begin with press-and-hold/push-to-talk, explicit OS microphone permission, visible capture indicator and safe STOP. Use supported local STT tool evaluated for hardware and license (faster-whisper or another suitable maintained free engine); don't require cloud or billing. If local speech is too slow, show honest constraints and request optional provider choice.
2. Use a built-in Windows TTS voice first if available and suitable; no copied Marvel actor voices, unlicensed voice clones or proprietary audio assets. Streaming interruption optional if affordable; don't fake lip sync or speaking state.
3. Wire actual audio energy levels/transcript/playing event to orb listening/thinking/speaking. Keep keyboard/text UI primary and working. Audio capture must not silently run in background. Respect reduced-motion.
4. Real microphone test on user's Windows machine, permission denial/unplug error and one actual spoken→authorized workflow scenario, with clearly reported test status.

DO NOT: full always-listening wake word, background surveillance, remote microphone transmission by default, visual redesign, or movie voice imitation.

Proposed commit message (text only, NEVER execute commit):
`feat: integrate push-to-talk voice with orb states`
