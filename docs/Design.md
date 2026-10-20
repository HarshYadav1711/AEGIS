# Design.md — AEGIS Orb / UI Vision (Open Visual System)
**Version:** 1.0 behavioral specification. **Status:** visual styling, fonts and typography expressly **UNDECIDED**.

## 1. Visual direction (conceptual only)
- **JARVIS:** precise holographic intelligence, layered meaningful structures and awareness.
- **ULTRON:** reactive energy, pulses and urgency tied to actual agent activity, never villain branding.
- **FRIDAY:** uncluttered, minimal and readable voice-first operation.
- Build an original visual design and implementation, not Marvel footage, logos, likenesses, proprietary sound, animations or exact Buildonaut source assets.

## 2. Orb is functional, not decorative
Input events/state source must drive transitions. A required visual states interface:
`idle`, `connecting`, `listening`, `thinking`, `planning`, `executing`, `waiting_approval`, `speaking`, `succeeded`, `error`, `cancelled`, `offline`.
Mapping examples: request queued→thinking; explicit action plan→planning; tool begins→executing; waiting on user→waiting_approval; real mic recording→listening; real TTS output→speaking; provider failure→error. A state should have associated text for accessibility. Do not fabricate task progress/time percentages.

## 3. Experience principles
Orb visually central, but chat input, task history, approvals, errors and outputs must be obvious and operational. Progressive disclosure for traces and diagnostics; avoid visual noise, fake telemetry, or extra panels whose functions are not implemented. Always show real model/provider status and progress. Desktop keyboard shortcuts only if implemented and documented. Orb clickable to focus the input; future click-to-record only after mic feature is real.

## 4. First running slice
Render an original animated orb from SVG/CSS/Canvas, with IDLE and real backend CONNECTING/READY/OFFLINE states, reduced-motion option. Include accessible text status. Do not make a purely frontend fake 'Listening' state on click. A clearly labeled **development-only state preview** can be used to inspect future state styling and must not be confused with production execution.

## 5. Visual fields specifically NOT locked
Color palette (including historical cybersec midnight/cyan), font family, type scale, letterspacing, spacing scale, grid, window chrome style, shadow/glow language, final 2D/3D technique and exact orb morphology. Choose later using installed Claude UI/design skills, user feedback and performance measurements. `Design.md` will be amended after explicit design selection.

## 6. Claude skills workflow
1. Inventory actual installed Claude UI/design skills in user's working environment; read their instructions, do not invent names or claim access without checking.
2. Prefer installed skills. If missing a necessary capability, propose a specific additional skill with source, license, security assessment, installation implications and why existing tools cannot solve it; STOP for approval before install.
3. Present 1–3 original visual alternatives only when the user requests visual selection. For early build, use a practical minimal orb baseline, not a locked final style.
4. Preserve accessible states, contrast, focus, reduced motion, performance and actual event links regardless of chosen style.

## 7. Responsive and performance
Desktop-first; design must adapt to small windows, no clipped approval buttons, no unreadable text. Prefer CSS/SVG/Canvas; start with one orb instance and no continuous heavy WebGL scene. Idle can limit animation frame rate; respect `prefers-reduced-motion`. Keyboard users must be able to access all controls even if orb effects are disabled.

## 8. Future design acceptance
Orb state truthfulness; coherent voice listening/speaking states; meaningful warning/success differences; clear display of action previews; input and transcript readability; contrast and reduced motion; measured idle CPU/energy overhead. No final font/color decisions are to be inferred from any initial demo.
