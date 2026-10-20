import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BackendState } from '../src/shared/contracts.ts';
import {
  approach,
  LIVE_ORB_STATES,
  ORB_LABELS,
  ORB_MOTION,
  ORB_STATES,
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
