import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseAddVaultNoteArgs,
  parseVaultQuery,
  parseVaultSearch,
  parseVaultWriteAreaArgs,
} from '../src/shared/contracts.ts';

const ID = '6f1d2c1e-8a0b-4c55-9d3e-0f6a7b8c9d01';
const T = '2026-10-22T00:00:00.000+00:00';

const vault = {
  id: ID, root_path: 'D:\\Notes', root_identity: '1:2', kind: 'existing', write_area: null, created_at: T,
  indexed_at: T, index_status: 'ok', index_detail: '1 new', counts: { indexed: 1 },
};
const note = {
  id: ID, vault_id: ID, vault_root: 'D:\\Notes', rel_path: 'Projects/Orion.md', status: 'indexed', author: 'user',
  title: 'Orion', tags: ['project'], links: [], size: 10, modified_at: T, sha256: 'ab', version: 1,
  first_seen_at: T, indexed_at: T, deleted_at: null, snippet: 'the «Falcon» runner',
};

test('parses vault search results with source and authorship', () => {
  const parsed = parseVaultSearch({ notes: [note], vaults: [vault] });
  const hit = parsed?.notes[0];
  assert.ok(parsed && hit);
  assert.equal(hit.relPath, 'Projects/Orion.md');
  assert.equal(hit.author, 'user');
  assert.equal(parsed.vaults[0]?.writeArea, null);
});

test('rejects vault payloads outside the contract', () => {
  for (const bad of [{ author: 'aegis' }, { status: 'trusted' }, { id: '../x' }, { tags: 'project' }]) {
    assert.equal(parseVaultSearch({ notes: [{ ...note, ...bad }], vaults: [] }), null, JSON.stringify(bad));
  }
  assert.equal(parseVaultSearch({ notes: [], vaults: [{ ...vault, kind: 'repo' }] }), null);
  assert.equal(parseVaultSearch({ notes: [], vaults: [{ ...vault, counts: { indexed: 'x' } }] }), null);
});

test('renderer vault arguments never carry a path', () => {
  assert.deepEqual(parseAddVaultNoteArgs({ vaultId: ID, title: 't', body: 'b' }), { vaultId: ID, title: 't', body: 'b' });
  assert.equal(parseAddVaultNoteArgs({ vaultId: ID, title: 't', body: 'b', path: 'C:/x.md' }), null);
  assert.equal(parseAddVaultNoteArgs({ vaultId: 'C:/Notes', title: 't', body: 'b' }), null);
  assert.equal(parseAddVaultNoteArgs({ vaultId: ID, title: ' ', body: 'b' }), null);
  assert.deepEqual(parseVaultWriteAreaArgs({ vaultId: ID, enabled: true }), { vaultId: ID, enabled: true });
  assert.equal(parseVaultWriteAreaArgs({ vaultId: ID, enabled: 'yes' }), null);
  assert.equal(parseVaultQuery('orion'), 'orion');
  assert.equal(parseVaultQuery({ q: 'x' }), null);
  assert.equal(parseVaultQuery('x'.repeat(201)), null);
});
