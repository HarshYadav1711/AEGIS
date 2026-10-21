import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseInterpretResearchArgs,
  parseRefusedSources,
  parseResearchDetailWithDigest,
  parseResearchTaskList,
} from '../src/shared/contracts.ts';
import { orbStateFor } from '../src/orb/orbModel.ts';

const TASK_ID = '6f1d2c1e-8a0b-4c55-9d3e-0f6a7b8c9d01';
const SOURCE_ID = '1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8';
const DIGEST = 'ab'.repeat(32);

function coreDetail(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: TASK_ID,
      request_text: 'Research solar https://docs.example.com/solar',
      question: 'How efficient are solar panels?',
      key_terms: ['solar', 'efficiency'],
      plan_source: 'model',
      plan_model: 'qwen3:4b',
      plan_detail: 'qwen3:4b restated the question and proposed key terms.',
      plan_digest: DIGEST,
      model: 'qwen3:4b',
      status: 'awaiting_save',
      approval_at: '2026-10-22T00:00:00.000+00:00',
      cancel_requested: 0,
      error_code: null,
      error_detail: null,
      report_markdown: '# Research report',
      report_sha256: 'cd'.repeat(32),
      saved_path: null,
      saved_at: null,
      created_at: '2026-10-22T00:00:00.000+00:00',
      updated_at: '2026-10-22T00:00:00.000+00:00',
      started_at: '2026-10-22T00:00:00.000+00:00',
      finished_at: null,
    },
    sources: [
      {
        id: SOURCE_ID,
        task_id: TASK_ID,
        seq: 1,
        requested_url: 'https://docs.example.com/solar',
        final_url: 'https://docs.example.com/solar',
        canonical_url: 'https://docs.example.com/solar',
        status: 'extracted',
        code: 'ok',
        detail: 'Allowed by robots.txt.',
        http_status: 200,
        content_type: 'text/html',
        title: 'Solar panel basics',
        sha256: 'ef'.repeat(32),
        bytes: 1200,
        text_chars: 400,
        truncated: 0,
        redirects: '[]',
        retrieved_at: '2026-10-22T00:00:01.000+00:00',
      },
    ],
    report: {
      question: 'How efficient are solar panels?',
      generated_at: '2026-10-22 00:00 UTC',
      findings: [
        {
          id: 'F1',
          claim: 'Panels convert about 20 percent of sunlight.',
          citations: ['S1-P1'],
          invalid_citations: [],
          quote: 'convert about 20 percent',
          status: 'supported',
          reasons: [],
        },
      ],
      uncertainties: [],
      evidence_sufficient: true,
      limitations: ['Direct URLs only.'],
      sources: [],
      metadata: {},
    },
    events: [{ id: 1, at: '2026-10-22T00:00:00.000+00:00', kind: 'planned', detail: 'Plan via model' }],
    ...overrides,
  };
}

test('research detail parses and keeps the digest out of the renderer payload', () => {
  const parsed = parseResearchDetailWithDigest(coreDetail());
  assert.ok(parsed);
  assert.equal(parsed.digest, DIGEST);
  assert.equal(JSON.stringify(parsed.detail).includes(DIGEST), false);
  assert.equal(parsed.detail.task.status, 'awaiting_save');
  assert.equal(parsed.detail.sources[0]?.truncated, false);
  assert.equal(parsed.detail.report?.findings[0]?.status, 'supported');
});

test('research detail with unknown statuses or malformed fields is rejected', () => {
  const bad = [
    coreDetail({ task: { ...coreDetail().task, status: 'done' } }),
    coreDetail({ task: { ...coreDetail().task, plan_digest: 'short' } }),
    coreDetail({ sources: [{ ...coreDetail().sources[0], status: 'downloaded' }] }),
    coreDetail({ report: { ...coreDetail().report, findings: [{ id: 'F1', claim: 'x', status: 'proven' }] } }),
    coreDetail({ events: 'none' }),
  ];
  for (const value of bad) assert.equal(parseResearchDetailWithDigest(value), null);
  assert.ok(parseResearchDetailWithDigest(coreDetail({ report: null })));
});

test('research list and refusal lists parse strictly', () => {
  const list = parseResearchTaskList({
    tasks: [{ id: TASK_ID, question: 'q', status: 'completed', saved_path: 'D:\\r.md', created_at: 'x' }],
  });
  assert.equal(list?.[0]?.savedPath, 'D:\\r.md');
  assert.equal(parseResearchTaskList({ tasks: [{ id: 'nope', question: 'q', status: 'completed' }] }), null);
  assert.deepEqual(parseRefusedSources([{ url: 'http://127.0.0.1/', code: 'https_only', detail: 'd' }]), [
    { url: 'http://127.0.0.1/', code: 'https_only', detail: 'd' },
  ]);
  assert.equal(parseRefusedSources([{ url: 1 }]), null);
});

test('renderer research arguments carry text and model only', () => {
  assert.deepEqual(parseInterpretResearchArgs({ text: 'research x', model: 'qwen3:4b' }), {
    text: 'research x',
    model: 'qwen3:4b',
  });
  assert.equal(parseInterpretResearchArgs({ text: 'research x', model: null }), null);
  assert.equal(parseInterpretResearchArgs({ text: 'research x', model: 'm', urls: ['http://127.0.0.1'] }), null);
  assert.equal(parseInterpretResearchArgs({ text: ' ', model: 'm' }), null);
  assert.equal(parseInterpretResearchArgs({ text: 'x'.repeat(2001), model: 'm' }), null);
});

test('research activity drives the orb from real task states', () => {
  const online = {
    state: 'online' as const,
    detail: 'ok',
    checkedAt: null,
    health: null,
  };
  assert.equal(orbStateFor(online, 'none', true, 'planning'), 'planning');
  assert.equal(orbStateFor(online, 'none', true, 'executing'), 'executing');
  assert.equal(orbStateFor(online, 'none', true, 'generating'), 'thinking');
  assert.equal(orbStateFor(online, 'none', true, 'failed'), 'error');
  assert.equal(orbStateFor({ ...online, state: 'offline' }, 'none', true, 'generating'), 'offline');
});
