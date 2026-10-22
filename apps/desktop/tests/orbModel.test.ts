import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BackendState } from '../src/shared/contracts.ts';
import {
  approach,
  LIVE_ORB_STATES,
  ORB_LABELS,
  ORB_MOTION,
  ORB_STATES,
  orbStateFor,
  orbStateFromBackend,
} from '../src/orb/orbModel.ts';

const status = (state: BackendState) => ({ state, detail: '', checkedAt: null, health: null });

test('maps real backend states to orb states', () => {
  assert.equal(orbStateFromBackend(null), 'connecting');
  assert.equal(orbStateFromBackend(status('starting')), 'connecting');
  assert.equal(orbStateFromBackend(status('online')), 'idle');
  assert.equal(orbStateFromBackend(status('degraded')), 'error');
  assert.equal(orbStateFromBackend(status('offline')), 'offline');
  assert.equal(orbStateFromBackend(status('error')), 'error');
});

test('backend events can never produce activity states that Phase 0 cannot observe', () => {
  const reachable = new Set(
    (['starting', 'online', 'degraded', 'offline', 'error'] as const).map((s) => orbStateFromBackend(status(s))),
  );
  for (const state of reachable) assert.ok(LIVE_ORB_STATES.includes(state), state);
  for (const fake of ['listening', 'thinking', 'speaking', 'executing'] as const) assert.ok(!reachable.has(fake));
});

test('every orb state has a label and bounded, non-strobing motion', () => {
  for (const state of ORB_STATES) {
    assert.ok(ORB_LABELS[state].length > 0, state);
    const m = ORB_MOTION[state];
    assert.ok(m.pulseHz > 0 && m.pulseHz <= 1.2, `${state} pulse ${m.pulseHz}`);
    assert.ok(m.maxFps >= 10 && m.maxFps <= 60, `${state} fps ${m.maxFps}`);
  }
  assert.ok(ORB_MOTION.offline.maxFps < ORB_MOTION.idle.maxFps, 'offline should render cheaper than idle');
});

test('approach eases toward the target without overshoot', () => {
  assert.equal(approach(0, 1, 0), 0);
  const step = approach(0, 1, 0.1);
  assert.ok(step > 0 && step < 1);
  assert.ok(Math.abs(approach(0, 1, 10) - 1) < 1e-6);
});

const online = status('online');

test('conversation activity drives the orb only while the core is online', () => {
  assert.equal(orbStateFor(online, 'none', true), 'idle');
  assert.equal(orbStateFor(online, 'thinking', true), 'thinking');
  assert.equal(orbStateFor(online, 'responding', true), 'responding');
  assert.equal(orbStateFor(online, 'succeeded', true), 'succeeded');
  assert.equal(orbStateFor(online, 'failed', true), 'error');
  assert.equal(orbStateFor(online, 'cancelled', true), 'cancelled');
  // A dead core is never shown as busy, whatever the last request was doing.
  assert.equal(orbStateFor(status('offline'), 'responding', true), 'offline');
  assert.equal(orbStateFor(status('starting'), 'thinking', true), 'connecting');
  assert.equal(orbStateFor(status('degraded'), 'thinking', true), 'error');
});

test('idle means a model is ready; otherwise the orb reports a problem', () => {
  assert.equal(orbStateFor(online, 'none', false), 'error');
});

test('text output is distinct from audio; chat alone never claims listening or speaking', () => {
  assert.notEqual(ORB_LABELS.responding, ORB_LABELS.speaking);
  assert.notDeepEqual(ORB_MOTION.responding, ORB_MOTION.speaking);
  const activities = ['none', 'thinking', 'responding', 'succeeded', 'failed', 'cancelled'] as const;
  const reachable = new Set(activities.flatMap((a) => [orbStateFor(online, a, true), orbStateFor(online, a, false)]));
  for (const state of reachable) assert.ok(LIVE_ORB_STATES.includes(state), state);
  // Streaming text is "responding"; only real microphone capture / audio playback (voice activity) reach these.
  for (const audioOnly of ['speaking', 'listening', 'transcribing'] as const) assert.ok(!reachable.has(audioOnly), audioOnly);
  // Chat alone never claims tool activity; those states come only from file-task events.
  for (const toolState of ['executing', 'planning', 'waiting_approval'] as const) assert.ok(!reachable.has(toolState));
});

test('file-task activity drives planning, approval and execution states', () => {
  assert.equal(orbStateFor(online, 'none', true, 'interpreting'), 'thinking');
  assert.equal(orbStateFor(online, 'none', true, 'waiting_folder'), 'waiting_approval');
  assert.equal(orbStateFor(online, 'none', true, 'planning'), 'planning');
  assert.equal(orbStateFor(online, 'none', true, 'waiting_approval'), 'waiting_approval');
  assert.equal(orbStateFor(online, 'none', true, 'executing'), 'executing');
  assert.equal(orbStateFor(online, 'none', true, 'succeeded'), 'succeeded');
  assert.equal(orbStateFor(online, 'none', true, 'failed'), 'error');
  assert.equal(orbStateFor(online, 'none', true, 'cancelled'), 'cancelled');
  // A dead core is never shown as executing.
  assert.equal(orbStateFor(status('offline'), 'none', true, 'executing'), 'offline');
  const activities = [
    'interpreting', 'waiting_folder', 'planning', 'waiting_approval', 'executing', 'succeeded', 'failed', 'cancelled',
  ] as const;
  for (const a of activities) assert.ok(LIVE_ORB_STATES.includes(orbStateFor(online, 'none', true, a)), a);
});

test('voice activity drives listening, transcribing and speaking only while the core is online', () => {
  assert.equal(orbStateFor(online, 'none', true, 'none', 'listening'), 'listening');
  assert.equal(orbStateFor(online, 'none', true, 'none', 'transcribing'), 'transcribing');
  assert.equal(orbStateFor(online, 'none', true, 'none', 'speaking'), 'speaking');
  assert.equal(orbStateFor(online, 'none', true, 'none', 'applying'), 'executing');
  assert.equal(orbStateFor(online, 'none', true, 'none', 'succeeded'), 'succeeded');
  assert.equal(orbStateFor(online, 'none', true, 'none', 'failed'), 'error');
  assert.equal(orbStateFor(online, 'none', true, 'none', 'cancelled'), 'cancelled');
  // A dead core is never shown as listening or speaking.
  assert.equal(orbStateFor(status('offline'), 'none', true, 'none', 'listening'), 'offline');
  assert.equal(orbStateFor(status('degraded'), 'none', true, 'none', 'speaking'), 'error');
  for (const v of ['listening', 'transcribing', 'speaking', 'applying', 'succeeded', 'failed', 'cancelled'] as const) {
    assert.ok(LIVE_ORB_STATES.includes(orbStateFor(online, 'none', true, 'none', v)), v);
  }
});

test('live audio outranks text and tasks; a finished voice step does not hide a running request', () => {
  // Speech plays after the reply is complete: speaking wins over the settled chat state.
  assert.equal(orbStateFor(online, 'succeeded', true, 'none', 'speaking'), 'speaking');
  // A voice step that merely ended (Done/Cancelled) never masks a request that is still running.
  assert.equal(orbStateFor(online, 'thinking', true, 'none', 'succeeded'), 'thinking');
  assert.equal(orbStateFor(online, 'none', true, 'waiting_approval', 'cancelled'), 'waiting_approval');
  assert.equal(orbStateFor(online, 'responding', true, 'none', 'none'), 'responding');
  assert.notEqual(ORB_LABELS.transcribing, ORB_LABELS.thinking);
});
