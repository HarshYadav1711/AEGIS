import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isChatProgressEvent,
  isUuid,
  MAX_PROMPT_CHARS,
  parseConversationDetail,
  parseHealthResponse,
  parseSendMessageArgs,
  parseStreamEvent,
} from '../src/shared/contracts.ts';

const RID = '0b7b5bb4-7f1e-4c4e-9f0e-6a1f6f0f2a10';
const CID = '6d9f8f4e-2c41-4a8b-9a51-9ad8e8a3c7e1';
const MID = 'c3a4f1f2-5b6e-4d7a-8c9b-0a1b2c3d4e5f';

const coreMessage = (over: Record<string, unknown> = {}) => ({
  id: MID,
  conversation_id: CID,
  seq: 2,
  role: 'assistant',
  content: 'hello',
  status: 'complete',
  reply_to: null,
  client_request_id: null,
  provider: 'ollama',
  model: 'llama3.2:3b',
  error_code: null,
  error_detail: null,
  finish_reason: 'stop',
  prompt_tokens: 31,
  completion_tokens: 4,
  duration_ms: 812,
  created_at: '2026-10-21T00:00:00.000+00:00',
  completed_at: '2026-10-21T00:00:01.000+00:00',
  ...over,
});

test('stream events parse into typed progress and outcomes', () => {
  assert.deepEqual(parseStreamEvent(RID, { type: 'delta', message_id: MID, text: 'Hi' }), {
    type: 'delta',
    requestId: RID,
    messageId: MID,
    text: 'Hi',
  });
  const complete = parseStreamEvent(RID, { type: 'complete', message: coreMessage() });
  assert.equal(complete?.type, 'complete');
  assert.equal(complete && 'message' in complete ? complete.message.model : null, 'llama3.2:3b');
  const failed = parseStreamEvent(RID, {
    type: 'failed',
    message: coreMessage({ status: 'failed', error_code: 'timeout', error_detail: 'slow' }),
    error: { code: 'timeout', detail: 'slow' },
  });
  assert.equal(failed?.type, 'failed');
});

test('stream events that contradict the contract are rejected', () => {
  const bad: unknown[] = [
    null,
    { type: 'delta', message_id: 'nope', text: 'x' },
    { type: 'delta', message_id: MID, text: 5 },
    // A "complete" event whose stored status is not complete must never be shown as success.
    { type: 'complete', message: coreMessage({ status: 'streaming' }) },
    { type: 'failed', message: coreMessage({ status: 'failed' }) },
    { type: 'complete', message: coreMessage({ role: 'system' }) },
    { type: 'complete', message: coreMessage({ completion_tokens: -1 }) },
    { type: 'tool_call', name: 'shell' },
  ];
  for (const value of bad) assert.equal(parseStreamEvent(RID, value), null, JSON.stringify(value));
});

test('send arguments from the renderer are validated strictly', () => {
  const ok = { conversationId: CID, requestId: RID, content: 'hi', model: 'llama3.2:3b' };
  assert.deepEqual(parseSendMessageArgs(ok), ok);
  const bad: unknown[] = [
    undefined,
    { ...ok, content: '   ' },
    { ...ok, content: 'x'.repeat(MAX_PROMPT_CHARS + 1) },
    { ...ok, model: '../etc/passwd' },
    { ...ok, model: '' },
    { ...ok, conversationId: 'abc' },
    { ...ok, requestId: RID.toUpperCase() },
    { ...ok, extra: true },
  ];
  for (const value of bad) assert.equal(parseSendMessageArgs(value), null, JSON.stringify(value));
});

test('conversation detail parsing rejects any malformed message', () => {
  const conversation = { id: CID, title: 't', created_at: 'a', updated_at: 'b', message_count: 1 };
  assert.equal(parseConversationDetail({ conversation, messages: [coreMessage()] })?.messages.length, 1);
  assert.equal(parseConversationDetail({ conversation, messages: [coreMessage({ status: 'done' })] }), null);
});

test('progress guard and uuid helper', () => {
  assert.ok(isUuid(RID));
  assert.ok(!isUuid('x'));
  assert.ok(isChatProgressEvent({ type: 'streaming', requestId: RID, messageId: MID }));
  assert.ok(!isChatProgressEvent({ type: 'complete', requestId: RID }));
});

test('health provider block is parsed and validated', () => {
  const base = {
    status: 'ok',
    service: 'aegis-core',
    version: '0.1.0',
    uptime_seconds: 1,
    database: { ok: true, schema_version: 2, journal_mode: 'wal', fts5_available: true },
    capabilities: { chat: true },
  };
  const provider = { id: 'ollama', base_url: 'http://127.0.0.1:11434', reachable: true, detail: 'ok', models: ['m'] };
  assert.deepEqual(parseHealthResponse({ ...base, provider })?.provider, {
    id: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    reachable: true,
    detail: 'ok',
    models: ['m'],
  });
  assert.equal(parseHealthResponse({ ...base, provider: null })?.provider, null);
  assert.equal(parseHealthResponse({ ...base, provider: { ...provider, models: [1] } }), null);
});
