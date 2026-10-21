import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseAddMemoryArgs,
  parseCorrectMemoryArgs,
  parseMemoryDecisionArgs,
  parseMemoryList,
  parseMemoryQueryArgs,
  parseMemorySettingsArgs,
} from '../src/shared/contracts.ts';

const ID = '6f1d2c1e-8a0b-4c55-9d3e-0f6a7b8c9d01';

function coreMemory(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    lineage_id: ID,
    version: 1,
    kind: 'fact',
    subject: 'test folder name',
    content: 'my test folder name is Zephyr-42',
    scope: 'global',
    status: 'active',
    verification: 'user_stated',
    source_event_id: ID,
    supersedes_id: null,
    superseded_by: null,
    conflicts_with: null,
    observed_at: '2026-10-22T00:00:00.000+00:00',
    recorded_at: '2026-10-22T00:00:00.000+00:00',
    expires_at: null,
    status_at: '2026-10-22T00:00:00.000+00:00',
    status_reason: null,
    expired: false,
    current: true,
    used_count: 2,
    source: {
      kind: 'remember',
      source_type: 'user_message',
      source_id: ID,
      conversation_id: ID,
      at: '2026-10-22T00:00:00.000+00:00',
      detail: 'Explicit remember instruction in chat.',
    },
    ...overrides,
  };
}

test('parses a memory list with provenance', () => {
  const list = parseMemoryList({ memories: [coreMemory()], settings: { capture_enabled: true, project: null } });
  const first = list?.memories[0];
  assert.ok(list && first);
  assert.equal(first.content, 'my test folder name is Zephyr-42');
  assert.equal(first.source?.sourceType, 'user_message');
  assert.equal(first.usedCount, 2);
  assert.deepEqual(list.settings, { captureEnabled: true, project: null });
});

test('rejects memory records outside the contract', () => {
  const settings = { capture_enabled: true, project: null };
  for (const bad of [{ status: 'verified' }, { kind: 'instruction' }, { verification: 'admin' }, { id: '../x' },
    { current: 'yes' }, { source: { kind: 'remember' } }]) {
    assert.equal(parseMemoryList({ memories: [coreMemory(bad)], settings }), null, JSON.stringify(bad));
  }
});

test('renderer memory arguments carry text and ids only', () => {
  const add = { content: 'I prefer tabs', kind: 'preference', subject: null, scope: 'global', expiresOn: null };
  assert.deepEqual(parseAddMemoryArgs(add), add);
  assert.equal(parseAddMemoryArgs({ ...add, status: 'active' }), null);
  assert.equal(parseAddMemoryArgs({ ...add, kind: 'experience' }), null);
  assert.equal(parseAddMemoryArgs({ ...add, scope: 'project:other' }), null);
  assert.equal(parseAddMemoryArgs({ ...add, content: 'x'.repeat(501) }), null);
  assert.equal(parseAddMemoryArgs({ ...add, expiresOn: 'tomorrow' }), null);

  assert.deepEqual(parseCorrectMemoryArgs({ id: ID, content: 'new' }), { id: ID, content: 'new' });
  assert.equal(parseCorrectMemoryArgs({ id: '../x', content: 'new' }), null);
  assert.equal(parseCorrectMemoryArgs({ id: ID, content: '   ' }), null);

  assert.deepEqual(parseMemoryDecisionArgs({ id: ID, action: 'delete' }), { id: ID, action: 'delete' });
  assert.equal(parseMemoryDecisionArgs({ id: ID, action: 'activate' }), null);

  assert.deepEqual(parseMemoryQueryArgs({ query: 'zephyr', includeHistory: true }), { query: 'zephyr', includeHistory: true });
  assert.equal(parseMemoryQueryArgs({ query: 'x', includeHistory: false, sql: '1=1' }), null);

  assert.deepEqual(parseMemorySettingsArgs({ captureEnabled: false, project: 'aegis' }), { captureEnabled: false, project: 'aegis' });
  assert.equal(parseMemorySettingsArgs({ captureEnabled: true, project: '../etc' }), null);
});
