import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isFileTaskProgressEvent,
  parseFileTaskDetailWithDigest,
  parseInterpretArgs,
  parsePlanDecisionArgs,
} from '../src/shared/contracts.ts';

const TASK_ID = '6f1d2c1e-8a0b-4c55-9d3e-0f6a7b8c9d01';
const PLAN_ID = '1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8';
const OP_ID = 'aa2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8';
const DIGEST = 'ab'.repeat(32);

function coreTask(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: TASK_ID,
      request_text: 'Organize the files in this folder by their types.',
      intent: 'organize_by_type',
      intent_source: 'model',
      intent_model: 'qwen3:4b',
      intent_detail: 'qwen3:4b classified the request.',
      status: 'awaiting_approval',
      root_path: 'D:\\Sandbox\\inbox',
      root_identity: '1:2',
      current_plan_id: PLAN_ID,
      approval_decision: null,
      approval_plan_id: null,
      approval_at: null,
      cancel_requested: 0,
      error_code: null,
      error_detail: null,
      created_at: '2026-10-21T00:00:00.000+00:00',
      updated_at: '2026-10-21T00:00:00.000+00:00',
      started_at: null,
      finished_at: null,
    },
    plan: {
      id: PLAN_ID,
      task_id: TASK_ID,
      digest: DIGEST,
      status: 'awaiting_approval',
      root_path: 'D:\\Sandbox\\inbox',
      root_identity: '1:2',
      created_at: '2026-10-21T00:00:00.000+00:00',
      expires_at: '2026-10-21T00:15:00.000+00:00',
    },
    operations: [
      {
        id: OP_ID,
        plan_id: PLAN_ID,
        seq: 1,
        action: 'move',
        source_name: 'report.pdf',
        category: 'Documents',
        dest_rel: 'Documents/report.pdf',
        size: 10,
        mtime_ns: 1,
        file_id: '1:3',
        sha256: 'cd'.repeat(32),
        plan_reason: null,
        status: 'planned',
        detail: null,
        verification: null,
        started_at: null,
        finished_at: null,
      },
    ],
    events: [{ id: 1, at: '2026-10-21T00:00:00.000+00:00', kind: 'plan_created', detail: 'Plan …' }],
    ...overrides,
  };
}

test('task detail parses, and the plan digest stays out of the renderer-facing detail', () => {
  const parsed = parseFileTaskDetailWithDigest(coreTask());
  assert.ok(parsed);
  assert.equal(parsed.digest, DIGEST);
  assert.equal(parsed.detail.plan?.id, PLAN_ID);
  assert.ok(!JSON.stringify(parsed.detail).includes(DIGEST));
  assert.equal(parsed.detail.operations[0]?.destRel, 'Documents/report.pdf');
});

test('malformed task payloads are rejected', () => {
  assert.equal(parseFileTaskDetailWithDigest(coreTask({ plan: { ...coreTask().plan, task_id: PLAN_ID } })), null);
  assert.equal(parseFileTaskDetailWithDigest(coreTask({ plan: { ...coreTask().plan, digest: 'nothex' } })), null);
  const badStatus = coreTask();
  badStatus.task.status = 'approved_by_model';
  assert.equal(parseFileTaskDetailWithDigest(badStatus), null);
  const badOp = coreTask();
  (badOp.operations[0] as Record<string, unknown>).action = 'delete';
  assert.equal(parseFileTaskDetailWithDigest(badOp), null);
});

test('interpret arguments: text and model only, no paths or extra fields', () => {
  assert.deepEqual(parseInterpretArgs({ text: 'organize my files', model: null }), {
    text: 'organize my files',
    model: null,
  });
  assert.equal(parseInterpretArgs({ text: 'organize', model: null, rootPath: 'C:\\' }), null);
  assert.equal(parseInterpretArgs({ text: '   ', model: null }), null);
  assert.equal(parseInterpretArgs({ text: 'x'.repeat(2001), model: null }), null);
  assert.equal(parseInterpretArgs({ text: 'ok', model: 'bad model name' }), null);
});

test('approve/reject arguments carry ids only: no digest, no approval flag, no path', () => {
  assert.deepEqual(parsePlanDecisionArgs({ taskId: TASK_ID, planId: PLAN_ID }), { taskId: TASK_ID, planId: PLAN_ID });
  assert.equal(parsePlanDecisionArgs({ taskId: TASK_ID, planId: PLAN_ID, planDigest: DIGEST }), null);
  assert.equal(parsePlanDecisionArgs({ taskId: TASK_ID, planId: PLAN_ID, approved: true }), null);
  assert.equal(parsePlanDecisionArgs({ taskId: 'C:\\Windows', planId: PLAN_ID }), null);
});

test('progress events are validated', () => {
  assert.ok(isFileTaskProgressEvent({ type: 'planning', taskId: TASK_ID }));
  assert.ok(!isFileTaskProgressEvent({ type: 'executing', taskId: TASK_ID }));
  assert.ok(!isFileTaskProgressEvent({ type: 'planning', taskId: 'x' }));
});
