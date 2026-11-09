// The one lookup every read of an archived turn goes through (#305; designs/305-archive-turns.md, “Read paths and
// access patterns”, I6): archived(state, blobs, convId, { turnId } | { entryId }). The SHA-256 it reads comes only from
// a turn summary in the state, and the file must be that conversation’s and that turn’s.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { archived } from '../server/work-archive-read.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { archiveEvent } from './work-archive-fixture.mjs';

const C = 'th_c';
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Blobs that hold `files` by their SHA-256 and record each get. */
function fakeBlobs(...files) {
  const byHash = new Map(files.map((f) => [sha(f), Buffer.from(f)]));
  const reads = [];
  return {
    reads,
    async get(h) {
      reads.push(h);
      const b = byHash.get(h);
      if (!b) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return b;
    },
  };
}

/** A state whose conversation C has turn t1 archived to `file`, and t2 hot. */
function stateWith(file, work) {
  const s = emptyState();
  s.threads[C] = { id: C, members: [] };
  for (const entry of [...work, { id: 't2', kind: 'turn', turnId: 't2', at: 9 }]) apply(s, 'work.add', { convId: C, entry });
  apply(s, 'turn.archive', archiveEvent(C, 't1', sha(file), work));
  return s;
}

const WORK = [
  { id: 't1', kind: 'turn', turnId: 't1', handle: 'alpha', at: 1 },
  { id: 'c1', kind: 'command', turnId: 't1', handle: 'alpha', command: 'ls', at: 2 },
];
const FILE = JSON.stringify({ v: 1, convId: C, turnId: 't1', work: WORK, activity: {} });

test('an archived entry id resolves to its turn and the entry, with one read of the file its summary names', async () => {
  const blobs = fakeBlobs(FILE);
  const got = await archived(stateWith(FILE, WORK), blobs, C, { entryId: 'c1' });
  assert.equal(got.turnId, 't1');
  assert.equal(got.entry.command, 'ls');
  assert.deepEqual(blobs.reads, [sha(FILE)]);
});

test('a turn id reads the file its summary names, and nothing else', async () => {
  const blobs = fakeBlobs(FILE);
  const got = await archived(stateWith(FILE, WORK), blobs, C, { turnId: 't1' });
  assert.deepEqual(
    got.work.map((e) => e.id),
    ['t1', 'c1'],
  );
  assert.deepEqual(blobs.reads, [sha(FILE)]);
});

test('a hot turn, a hot entry or another conversation is a 404 with a sentence, and reads no file', async () => {
  const blobs = fakeBlobs(FILE);
  const s = stateWith(FILE, WORK);
  for (const [convId, key] of [
    [C, { turnId: 't2' }],
    [C, { entryId: 't2' }],
    ['th_other', { turnId: 't1' }],
    [C, { turnId: sha(FILE) }],
  ]) {
    await assert.rejects(archived(s, blobs, convId, key), (e) => e.status === 404 && /isn’t (archived|in this conversation’s archived work)/.test(e.message));
  }
  assert.deepEqual(blobs.reads, [], 'no request reaches the blob store');
});

test('a file for another turn or conversation, under the summary’s hash, is a 410', async () => {
  for (const wrong of [
    JSON.stringify({ v: 1, convId: C, turnId: 't9', work: WORK, activity: {} }),
    JSON.stringify({ v: 1, convId: 'th_other', turnId: 't1', work: WORK, activity: {} }),
    JSON.stringify({ v: 2, convId: C, turnId: 't1', work: WORK, activity: {} }),
    'not json',
  ]) {
    await assert.rejects(archived(stateWith(wrong, WORK), fakeBlobs(wrong), C, { turnId: 't1' }), (e) => e.status === 410);
  }
});

test('an entry its summary lists but its file lacks is a 410, not a 404: the file is what’s wrong', async () => {
  const short = JSON.stringify({ v: 1, convId: C, turnId: 't1', work: [WORK[0]], activity: {} });
  await assert.rejects(archived(stateWith(short, WORK), fakeBlobs(short), C, { entryId: 'c1' }), (e) => e.status === 410);
});
