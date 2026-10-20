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

test('text output is distinct from audio and audio stays unreachable', () => {
  assert.notEqual(ORB_LABELS.responding, ORB_LABELS.speaking);
  assert.notDeepEqual(ORB_MOTION.responding, ORB_MOTION.speaking);
  const activities = ['none', 'thinking', 'responding', 'succeeded', 'failed', 'cancelled'] as const;
  const reachable = new Set(activities.flatMap((a) => [orbStateFor(online, a, true), orbStateFor(online, a, false)]));
  for (const state of reachable) assert.ok(LIVE_ORB_STATES.includes(state), state);
  for (const notYet of ['speaking', 'listening', 'executing', 'planning', 'waiting_approval'] as const) {
    assert.ok(!reachable.has(notYet), notYet);
    assert.ok(!LIVE_ORB_STATES.includes(notYet), notYet);
  }
});
