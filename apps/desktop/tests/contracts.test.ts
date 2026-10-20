import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isBackendStatus, parseHealthResponse } from '../src/shared/contracts.ts';

const validHealth = {
  status: 'ok',
  service: 'aegis-core',
  version: '0.1.0',
  uptime_seconds: 3.2,
  database: { ok: true, schema_version: 1, journal_mode: 'wal', fts5_available: true },
  capabilities: { chat: false },
};

test('parses a contract-conforming health response', () => {
  assert.deepEqual(parseHealthResponse(validHealth), {
    status: 'ok',
    version: '0.1.0',
    uptimeSeconds: 3.2,
    database: { ok: true, schemaVersion: 1, journalMode: 'wal', fts5Available: true },
    capabilities: { chat: false },
    provider: null,
  });
});

test('rejects health responses that do not match the contract', () => {
  const cases: unknown[] = [
    null,
    'ok',
    [],
    { ...validHealth, service: 'something-else' },
    { ...validHealth, status: 'great' },
    { ...validHealth, version: '' },
    { ...validHealth, uptime_seconds: -1 },
    { ...validHealth, uptime_seconds: Number.NaN },
    { ...validHealth, database: { ...validHealth.database, ok: 'yes' } },
    { ...validHealth, capabilities: {} },
    { ...validHealth, capabilities: { chat: 'true' } },
  ];
  for (const value of cases) assert.equal(parseHealthResponse(value), null, JSON.stringify(value));
});

test('guards BackendStatus values crossing IPC', () => {
  const health = parseHealthResponse(validHealth);
  assert.ok(isBackendStatus({ state: 'online', detail: 'ok', checkedAt: '2026-10-21T00:00:00Z', health }));
  assert.ok(isBackendStatus({ state: 'offline', detail: 'gone', checkedAt: null, health: null }));
  assert.equal(isBackendStatus({ state: 'listening', detail: '', checkedAt: null, health: null }), false);
  assert.equal(isBackendStatus({ state: 'online', detail: 1, checkedAt: null, health: null }), false);
  assert.equal(isBackendStatus({ state: 'online', detail: '', checkedAt: null, health: { status: 'ok' } }), false);
  assert.equal(isBackendStatus(undefined), false);
});
