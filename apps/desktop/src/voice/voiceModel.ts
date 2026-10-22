// Pure voice-flow helpers (no DOM access; unit-tested with the Node runner).

import type { CorrectionCategory, VoiceCategory, VoiceInterpretation } from '../shared/contracts';

/**
 * Where the push-to-talk flow is, from real events only:
 * requesting   — waiting for the microphone permission / device to open
 * listening    — the microphone is capturing (tracks live)
 * transcribing — the recording is with the local speech engine
 * interpreting — the transcript is being classified (deterministic, no model)
 * review       — the transcript or a memory change waits for the user
 * applying     — a reviewed memory correction is being written
 * synthesizing — speech audio is being generated (nothing audible yet)
 * speaking     — synthesized audio is actually playing
 */
export type VoicePhase =
  | 'idle'
  | 'requesting'
  | 'listening'
  | 'transcribing'
  | 'interpreting'
  | 'review'
  | 'applying'
  | 'synthesizing'
  | 'speaking';

/** Finished state shown briefly on the orb after a voice step. */
export type VoiceOutcome = 'none' | 'succeeded' | 'failed' | 'cancelled';

export interface VoiceError {
  code: string;
  detail: string;
}

/** Explain a getUserMedia failure (DOMException name) in the user's terms. */
export function microphoneError(name: string): VoiceError {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        code: 'mic_denied',
        detail:
          'Microphone access was denied. Allow microphone access for desktop apps in Windows Settings → ' +
          'Privacy & security → Microphone, then try again.',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { code: 'mic_not_found', detail: 'No microphone was found, or the selected one is no longer connected.' };
    case 'NotReadableError':
    case 'AbortError':
      return { code: 'mic_unreadable', detail: 'The microphone could not be opened (in use by another app or blocked by Windows).' };
    default:
      return { code: 'mic_error', detail: 'The microphone could not be started.' };
  }
}

export const CATEGORY_LABELS: Record<VoiceCategory, string> = {
  explicit_correction: 'Explicit correction',
  project_exception: 'Narrows where the memory applies (exception)',
  temporary: 'Sounds temporary',
  transcription_doubt: 'Speech engine was not confident',
  conflicting_claim: 'Conflicts with a current memory',
};

/** Same rule as the core (voice_commands.propose_revision): the user's words are kept verbatim. */
export function proposeRevision(oldContent: string, body: string, category: CorrectionCategory): string {
  const sentence = (text: string) => {
    const t = text.trim().replace(/[ .]+$/, '');
    return t ? t[0]!.toUpperCase() + t.slice(1) : t;
  };
  if (category === 'explicit_correction') return `${sentence(body)}.`;
  return `${sentence(oldContent)} (correction: ${body.trim().replace(/[ .]+$/, '')}).`;
}

/** The category to send with an applied correction (a conflict label never applies to a correction). */
export function correctionCategory(interpretation: VoiceInterpretation): CorrectionCategory {
  const c = interpretation.category;
  return c === null || c === 'conflicting_claim' ? 'explicit_correction' : c;
}

/** Whether a transcript may be sent without showing it first. Memory changes and refusals are always shown. */
export function canAutoSend(interpretation: VoiceInterpretation, autoSend: boolean): boolean {
  return autoSend && !interpretation.reviewRequired && (interpretation.kind === 'chat' || interpretation.kind === 'recall');
}
