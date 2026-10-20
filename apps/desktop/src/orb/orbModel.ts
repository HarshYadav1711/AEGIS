// Pure orb state model: which visual state to show, its accessible text, and
// the motion parameters the canvas renderer interpolates toward.
// No DOM access here so it can be unit-tested with the Node test runner.

import type { BackendState, BackendStatus } from '../shared/contracts';

/**
 * Visual state vocabulary from Design.md §2, plus `responding`: the model is
 * streaming text. `speaking` stays reserved for real audio (TTS) playback.
 */
export type OrbState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'planning'
  | 'executing'
  | 'waiting_approval'
  | 'responding'
  | 'speaking'
  | 'succeeded'
  | 'error'
  | 'cancelled'
  | 'offline';

export const ORB_STATES: readonly OrbState[] = [
  'idle',
  'connecting',
  'listening',
  'thinking',
  'planning',
  'executing',
  'waiting_approval',
  'responding',
  'speaking',
  'succeeded',
  'error',
  'cancelled',
  'offline',
];

/**
 * States that real Phase 1 events can produce (backend lifecycle + conversation
 * requests). Everything else is reachable only through the labelled preview.
 */
export const LIVE_ORB_STATES: readonly OrbState[] = [
  'connecting',
  'idle',
  'thinking',
  'responding',
  'succeeded',
  'cancelled',
  'error',
  'offline',
];

/**
 * What the current conversation request is doing, from real IPC events:
 * thinking   — request sent, no text yet
 * responding — text deltas are arriving
 * succeeded / failed / cancelled — the terminal status the core persisted
 */
export type ChatActivity = 'none' | 'thinking' | 'responding' | 'succeeded' | 'failed' | 'cancelled';

const FROM_BACKEND: Record<BackendState, OrbState> = {
  starting: 'connecting',
  online: 'idle',
  degraded: 'error',
  offline: 'offline',
  error: 'error',
};

export function orbStateFromBackend(status: BackendStatus | null): OrbState {
  return status ? FROM_BACKEND[status.state] : 'connecting';
}

const FROM_ACTIVITY: Record<Exclude<ChatActivity, 'none'>, OrbState> = {
  thinking: 'thinking',
  responding: 'responding',
  succeeded: 'succeeded',
  failed: 'error',
  cancelled: 'cancelled',
};

/**
 * Live orb state. Backend problems win (an unreachable core is never shown as
 * busy); otherwise the request activity; otherwise `idle` only when a model is
 * actually ready to answer.
 */
export function orbStateFor(status: BackendStatus | null, activity: ChatActivity, chatReady: boolean): OrbState {
  const backend = orbStateFromBackend(status);
  if (backend !== 'idle') return backend;
  if (activity !== 'none') return FROM_ACTIVITY[activity];
  return chatReady ? 'idle' : 'error';
}

export const ORB_LABELS: Record<OrbState, string> = {
  idle: 'Ready',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  planning: 'Planning',
  executing: 'Executing',
  waiting_approval: 'Waiting for approval',
  responding: 'Responding (text)',
  speaking: 'Speaking (audio)',
  succeeded: 'Done',
  error: 'Error',
  cancelled: 'Cancelled',
  offline: 'Offline',
};

/** Motion parameters, all in 0..1 unless noted. */
export interface OrbMotion {
  /** Shell rotation speed (radians per second). */
  spin: number;
  /** Core glow intensity. */
  energy: number;
  /** Radial displacement of shell particles (reactive "charge"). */
  turbulence: number;
  /** Breathing pulse frequency in Hz (kept ≤ 1.2 Hz; never strobing). */
  pulseHz: number;
  /** Overall brightness multiplier; low for offline/cancelled. */
  presence: number;
  /** 1 renders the travelling scan arc used for connecting/planning. */
  sweep: number;
  /** Upper bound for animation frame rate. */
  maxFps: number;
}

export const ORB_MOTION: Record<OrbState, OrbMotion> = {
  idle:             { spin: 0.18, energy: 0.45, turbulence: 0.05, pulseHz: 0.25, presence: 0.9,  sweep: 0, maxFps: 30 },
  connecting:       { spin: 0.35, energy: 0.35, turbulence: 0.08, pulseHz: 0.6,  presence: 0.75, sweep: 1, maxFps: 45 },
  listening:        { spin: 0.25, energy: 0.6,  turbulence: 0.18, pulseHz: 0.9,  presence: 1,    sweep: 0, maxFps: 60 },
  thinking:         { spin: 0.6,  energy: 0.75, turbulence: 0.22, pulseHz: 0.8,  presence: 1,    sweep: 0, maxFps: 60 },
  planning:         { spin: 0.45, energy: 0.65, turbulence: 0.12, pulseHz: 0.5,  presence: 1,    sweep: 1, maxFps: 60 },
  executing:        { spin: 0.9,  energy: 0.9,  turbulence: 0.3,  pulseHz: 1.1,  presence: 1,    sweep: 0, maxFps: 60 },
  waiting_approval: { spin: 0.08, energy: 0.55, turbulence: 0.04, pulseHz: 0.4,  presence: 0.95, sweep: 0, maxFps: 30 },
  responding:       { spin: 0.4,  energy: 0.8,  turbulence: 0.16, pulseHz: 1.0,  presence: 1,    sweep: 1, maxFps: 60 },
  speaking:         { spin: 0.3,  energy: 0.7,  turbulence: 0.25, pulseHz: 1.2,  presence: 1,    sweep: 0, maxFps: 60 },
  succeeded:        { spin: 0.15, energy: 0.6,  turbulence: 0.03, pulseHz: 0.2,  presence: 0.95, sweep: 0, maxFps: 30 },
  error:            { spin: 0.05, energy: 0.5,  turbulence: 0.14, pulseHz: 0.5,  presence: 0.9,  sweep: 0, maxFps: 30 },
  cancelled:        { spin: 0.04, energy: 0.2,  turbulence: 0.02, pulseHz: 0.15, presence: 0.55, sweep: 0, maxFps: 20 },
  offline:          { spin: 0.02, energy: 0.12, turbulence: 0,    pulseHz: 0.1,  presence: 0.4,  sweep: 0, maxFps: 15 },
};

/** Exponential approach used to ease motion between states (frame-rate independent). */
export function approach(current: number, target: number, dtSeconds: number, ratePerSecond = 4): number {
  const t = 1 - Math.exp(-ratePerSecond * Math.max(0, dtSeconds));
  return current + (target - current) * t;
}
