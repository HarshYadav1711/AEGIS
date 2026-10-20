# EVALUATION_PROTOCOL.md — Real Results, Not Decorative Benchmarks

## General rules
Report environment versions, hardware (if known), model identifier/revision, input fixture, task ID, seed where relevant, permission outcomes, elapsed time, output location, evidence, failure. Distinguish deterministic tests, mocked fixtures, actual Ollama calls, hosted provider and manually observed Windows GUI tests. No numeric metrics without real run. Do not compare unequal information or tool access.

## Progressive tests
- Phase 0: backend health positive/negative; Electron starts with Node disabled; IPC unauth/unknown rejected; orb `offline` shown when backend absent; reduced-motion works.
- Phase 1: real model smoke if configured; absent provider displays useful error; chat persistence across restart; broken JSON/tool claim not treated as success.
- Phase 2: actual fixture folder containing files and collisions; preview exactly matches effect; outside root, symlink, overwrite attempt blocked; manual approval required; actual moved output hash/manifest.
- Phase 3: independently checked publicly fetched URLs, source-grounded report, private-network navigation denied, injection text never becomes an action.
- Phase 4: repository report against frozen fixture with real file citations; no changes in fixture; secret/large/binary exclusions.
- Phase 5: user-recorded real mic/transcript/TTS smoke, denied mic and missing device error state.
- Phase 6: actual planner/executor/reviewer transitions, tool authorization checks and bounded retry.
- Phase 7: fresh-clone install, Windows executable boot, repeat end-to-end fixture tasks, document capabilities and gaps, evaluate held-out prompts, no fabricated success percent.

## Core measurements
Task completion with confirmed output; failed, partial and unknown counts; average/p95 latency if sample allows; tool count; model token estimate if provider returns it; local compute use if measured; cost (do not invent monetary values); malicious instruction attempts blocked; cancellation/retry outcomes. Small sample caveats always explicit.

## Artifact naming
`run_id`, `scenario_id`, `model_id`, `status`, `started_at`, `finished_at`, `inputs_manifest`, `policy_events`, `tool_events`, `output_artifact_hashes`, `verification`, `errors` and `limitations`. Do not retain secrets or full confidential content in logs.

## Demo integrity
A recorded real prior run can be used with clear 'REPLAY' label if offline. Never display saved old trace as live. No invented tests or false screenshots. A feature remains proposed until its own full acceptance gate is reproduced.
