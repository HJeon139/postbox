// Reading archived detail (#305, design "Read paths": A2 to A4): an archived turn's entries and a reply's steps come
// back from the archive file named by a summary in the state, never by a path from the request (I6); a file that is
// missing, damaged or for another turn answers 410, an unknown turn 404; and the ledger's diff and output fall back to
// the archive for an entry that is no longer live.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Blobs } from '../server/blobs.mjs';
import { memoryBlobs } from '../server/ledger-io.mjs';
import { Store } from '../server/store.mjs';
import { archiveTurns } from '../server/work-archive.mjs';
import { archivedActivity, archivedEntry, archivedTurn } from '../server/work-archive-read.mjs';

const C = 'th_c';
const T = 'th_topic';

/** t1 archived (a command, a change and a reply with steps in the topic thread), t2 and t3 left live. */
async function archivedRoom(blobs = memoryBlobs()) {
  const s = new Store(null);
  s.emit('thread', { id: C, members: [] });
  s.emit('thread', { id: T, parentId: C, members: [] });
  for (const [k, t] of ['t1', 't2', 't3'].entries()) {
    s.emit('work.add', { convId: C, entry: { id: t, kind: 'turn', turnId: t, handle: 'alpha', status: 'done', at: k * 10 } });
    s.emit('work.add', {
      convId: C,
      entry: {
        id: `c_${t}`,
        kind: 'command',
        turnId: t,
        handle: 'alpha',
        state: 'done',
        command: `ls ${t}`,
        output: { sha256: 'a'.repeat(64) },
        at: k * 10 + 1,
      },
    });
    s.emit('item.add', {
      threadId: T,
      item: { id: `r_${t}`, kind: 'agent', turnId: t, text: 'done', activity: { steps: [{ id: 's1', label: 'Read', detail: t }] } },
    });
  }
  await archiveTurns({ store: s, blobs, convId: C, running: new Set() });
  return { s, blobs };
}

test('an archived turn comes back whole: its entries and its replies’ steps, by thread and reply', async () => {
  const { s, blobs } = await archivedRoom();
  const got = await archivedTurn(s.state, blobs, C, 't1');
  assert.deepEqual(
    got.work.map((e) => e.id),
    ['t1', 'c_t1'],
  );
  assert.equal(got.activity[T].r_t1.steps[0].detail, 't1');
});

test('an entry is found by id through its summary, one file read, and an unknown id is a 404', async () => {
  const { s, blobs } = await archivedRoom();
  assert.equal((await archivedEntry(s.state, blobs, C, 'c_t1')).command, 'ls t1');
  await assert.rejects(archivedEntry(s.state, blobs, C, 'c_t2'), (e) => e.status === 404, 'a live entry isn’t an archived one');
  await assert.rejects(archivedEntry(s.state, blobs, C, 'nope'), (e) => e.status === 404);
});

test('a reply’s steps come back by thread and reply; a reply that isn’t archived is a 404', async () => {
  const { s, blobs } = await archivedRoom();
  const steps = await archivedActivity(s.state, blobs, T, 'r_t1');
  assert.equal(steps.steps[0].detail, 't1');
  await assert.rejects(archivedActivity(s.state, blobs, T, 'r_t3'), (e) => e.status === 404);
});

test('an unknown turn is a 404 with a sentence; the sha comes from the state, never the request (I6)', async () => {
  const { s, blobs } = await archivedRoom();
  await assert.rejects(archivedTurn(s.state, blobs, C, 'zzz'), (e) => e.status === 404 && /archived/i.test(e.message));
  await assert.rejects(archivedTurn(s.state, blobs, C, '../../etc/passwd'), (e) => e.status === 404);
});

test('a file that is gone, or damaged, answers 410, and a file for another turn is refused', async () => {
  const { s } = await archivedRoom();
  await assert.rejects(archivedTurn(s.state, memoryBlobs(), C, 't1'), (e) => e.status === 410 && /couldn’t be read/.test(e.message), 'gone');
  const dir = await mkdtemp(join(tmpdir(), 'pb-read-'));
  try {
    const blobs = new Blobs(dir);
    const { s: s2 } = await archivedRoom(blobs);
    const summary = s2.state.work[C].find((e) => e.kind === 'turn-archive');
    await writeFile(blobs.pathOf(summary.sha256), 'damaged, not the bytes whose hash is the name');
    await assert.rejects(archivedTurn(s2.state, blobs, C, 't1'), (e) => e.status === 410, 'damaged');
    const other = await blobs.put(Buffer.from(JSON.stringify({ v: 1, convId: C, turnId: 'tX', work: [], activity: {} })));
    s2.state.work[C].find((e) => e.kind === 'turn-archive').sha256 = other.sha256;
    await assert.rejects(archivedTurn(s2.state, blobs, C, 't1'), (e) => e.status === 410, 'a file that is for another turn');
    await mkdir(dir, { recursive: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
