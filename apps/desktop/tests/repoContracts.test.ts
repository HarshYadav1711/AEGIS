import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  parseRepoApproveArgs,
  parseRepoDetailWithDigest,
  parseRepoProposalArgs,
  parseRepoTaskList,
} from '../src/shared/contracts.ts';

// A real core response (read-only scan of a fixture repo; the model text in it was scripted test text).
const detail = JSON.parse(readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'repo-detail.json'), 'utf-8'));
const ID = '6f1d2c1e-8a0b-4c55-9d3e-0f6a7b8c9d01';

test('parses a real repository task detail; the digest stays with main', () => {
  const parsed = parseRepoDetailWithDigest(detail);
  assert.ok(parsed?.detail.plan && parsed.detail.report);
  assert.match(parsed.digest ?? '', /^[0-9a-f]{64}$/);
  assert.equal('planDigest' in parsed.detail.task, false);
  const { plan, report } = parsed.detail;
  assert.equal(plan.repoName, 'inventory');
  assert.ok(plan.checks.some((c) => c.path === 'inventory/api.py' && c.line === 14));
  assert.deepEqual(plan.sensitivePaths.sort(), ['.env', 'secrets.json']);
  assert.ok(report.findings.some((f) => f.status === 'likely_issue' && f.path === 'inventory/store.py'));
  assert.ok(report.findings.some((f) => f.status === 'removed'));
  assert.equal(report.unchanged, true);
});

test('support level separates a checked quote from a supported claim; older reports parse as unknown', () => {
  const [checked, , insufficient] = detail.report.model_findings;
  assert.ok(parseRepoDetailWithDigest(detail)?.detail.report?.findings.every((f) => f.support === null));
  const withSupport = (f: object) => ({ ...detail, report: { ...detail.report, model_findings: [f] } });
  const review = parseRepoDetailWithDigest(withSupport({ ...checked, support: 'needs_review' }));
  assert.equal(review?.detail.report?.findings[0]?.support, 'needs_review');
  assert.equal(parseRepoDetailWithDigest(withSupport({ ...checked, support: 'verified' })), null);
  assert.equal(parseRepoDetailWithDigest(withSupport({ ...insufficient, support: 'supported' })), null);
});

test('rejects repository payloads outside the contract', () => {
  const broken = [
    { ...detail, task: { ...detail.task, status: 'trusted' } },
    { ...detail, task: { ...detail.task, plan_digest: 'abc' } },
    { ...detail, report: { ...detail.report, model_findings: [{ ...detail.report.model_findings[0], status: 'verified' }] } },
    { ...detail, plan: { ...detail.plan, vault_notes: [{ note_id: '../x' }] } },
  ];
  for (const bad of broken) assert.equal(parseRepoDetailWithDigest(bad), null);
  assert.equal(parseRepoTaskList({ tasks: [{ id: ID, repo_name: null, status: 'running', saved_path: null, created_at: 'x' }] }), null);
});

test('renderer repository arguments never carry a path, digest or note list', () => {
  assert.deepEqual(parseRepoApproveArgs({ taskId: ID, useVaultNotes: true }), { taskId: ID, useVaultNotes: true });
  assert.equal(parseRepoApproveArgs({ taskId: ID, useVaultNotes: true, planDigest: '0'.repeat(64) }), null);
  assert.equal(parseRepoApproveArgs({ taskId: ID, useVaultNotes: 'yes' }), null);
  assert.equal(parseRepoApproveArgs({ taskId: 'C:/repo', useVaultNotes: false }), null);
  assert.equal(parseRepoApproveArgs({ taskId: ID, useVaultNotes: false, noteIds: [ID] }), null);
  assert.deepEqual(parseRepoProposalArgs({ taskId: ID, index: 0 }), { taskId: ID, index: 0 });
  assert.equal(parseRepoProposalArgs({ taskId: ID, index: -1 }), null);
  assert.equal(parseRepoProposalArgs({ taskId: ID, index: 0, content: 'x' }), null);
});
