// The archive pass (#305): when a conversation holds more than two turns of work, the oldest ended turn's work entries
// and its replies' activity go to an archive file in the blob store, written before the turn.archive event names it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryBlobs } from '../server/ledger-io.mjs';
import { Store } from '../server/store.mjs';
import { archiveTurns } from '../server/work-archive.mjs';

const C = 'th_c';
/** A store with one conversation, a topic thread off it, and `turns` turns of work; t2's reply is in the topic thread. */
function room(turns = ['t1', 't2', 't3']) {
  const s = new Store(null);
  s.emit('thread', { id: C, members: [] });
  s.emit('thread', { id: 'th_topic', parentId: C, members: [] });
  for (const [k, t] of turns.entries()) {
    for (let i = 1; i <= 2; i++)
      s.emit('work.add', {
        convId: C,
        entry: { id: `w_${t}_${i}`, turnId: t, kind: 'command', command: `npm test ${i}`, at: k * 10 + i, handle: 'researcher' },
      });
    const where = t === 't2' ? 'th_topic' : C;
    s.emit('item.add', {
      threadId: where,
      item: { id: `r_${t}`, kind: 'agent', turnId: t, text: 'done', activity: { steps: [{ id: 's1', label: 'Read', detail: t }] } },
    });
  }
  return s;
}

test('T-1: with three ended turns, the pass archives the first, and its archive file holds its entries and activity', async () => {
  const s = room();
  const blobs = memoryBlobs();
  await archiveTurns({ store: s, blobs, convId: C, running: new Set() });
  const list = s.state.work[C];
  assert.deepEqual(
    list.map((e) => e.id),
    [list[0].id, 'w_t2_1', 'w_t2_2', 'w_t3_1', 'w_t3_2'],
  );
  assert.equal(list[0].kind, 'turn-archive');
  assert.equal(list[0].counts.commands, 2);
  const file = JSON.parse((await blobs.get(list[0].sha256)).toString());
  assert.deepEqual(
    file.work.map((e) => e.id),
    ['w_t1_1', 'w_t1_2'],
  );
  assert.equal(file.activity[C].r_t1.steps[0].detail, 't1', 'activity is keyed by thread, then reply');
  assert.deepEqual(s.state.items[C][0].activity, { archived: list[0].sha256, count: 1 });
});

test('a reply in a topic thread is archived with its turn, not left behind (the conversation’s second surface)', async () => {
  const s = room(['t1', 't2', 't3', 't4']);
  await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() });
  assert.equal(s.state.items.th_topic[0].activity.archived?.length, 64, 't2’s reply in the topic thread points at its archive file');
});

test('T-3: a turn still running is never archived, even past two', async () => {
  const s = room();
  await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set(['t1']) });
  assert.ok(!s.state.work[C].some((e) => e.kind === 'turn-archive'));
});

test('the archive file is published before the event that names it, which is a commit with the turn id as its operation id', async () => {
  const s = room();
  const blobs = memoryBlobs();
  /** @type {{ events: any[], opId: string, fileThere: boolean }[]} */
  const commits = [];
  const store = Object.assign(Object.create(s), {
    commit: async (/** @type {any} */ events, /** @type {any} */ o) => {
      const ev = (typeof events === 'function' ? events(s.state) : events)[0];
      const fileThere = await blobs.get(ev.data.sha256).then(
        () => true,
        () => false,
      );
      commits.push({ events: [ev], opId: o?.opId, fileThere });
      s.emit(ev.type, ev.data);
      return { seq: s.state.seq, duplicate: false };
    },
  });
  await archiveTurns({ store, blobs, convId: C, running: new Set() });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].events[0].type, 'turn.archive');
  assert.equal(commits[0].opId, 'turn.archive:t1');
  assert.equal(commits[0].fileThere, true, 'the file was there when the event was committed');
});

test('I5, I8: a work.patch that lands between the file’s write and the commit makes the commit write nothing', async () => {
  const s = room();
  const blobs = memoryBlobs();
  const late = Object.assign(Object.create(blobs), {
    put: async (/** @type {Buffer} */ buf) => {
      const r = await blobs.put(buf);
      s.emit('work.patch', { convId: C, id: 'w_t1_1', patch: { output: 'a background command finished' } });
      return r;
    },
  });
  const seq = s.state.seq;
  assert.equal(await archiveTurns({ store: s, blobs: late, convId: C, running: new Set() }), 0);
  assert.equal(s.state.seq, seq + 1, 'only the patch was written');
  assert.ok(!s.state.work[C].some((e) => e.kind === 'turn-archive'));
  assert.equal(s.state.work[C][0].output, 'a background command finished', 'the patch is kept in the state');
});

test('a work.patch for an entry already archived is dropped, not resurrected (the backstop developer asked for)', async () => {
  const s = room();
  await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() });
  const before = JSON.stringify(s.state.work[C]);
  s.emit('work.patch', { convId: C, id: 'w_t1_1', patch: { output: 'late' } });
  assert.equal(JSON.stringify(s.state.work[C]), before);
});

test('with five ended turns the pass archives three, oldest first, and stops at two hot turns', async () => {
  const s = room(['t1', 't2', 't3', 't4', 't5']);
  assert.equal(await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() }), 3);
  assert.deepEqual(
    s.state.work[C].filter((e) => e.kind === 'turn-archive').map((e) => e.turnId),
    ['t1', 't2', 't3'],
  );
});

for (const state of ['running', 'background', 'unknown'])
  test(`I4: a command left ${state} keeps its turn hot, and later ended turns are archived past it (critic, ledger.mjs:434-511)`, async () => {
    const s = room(['t1', 't2', 't3', 't4']);
    s.emit('work.patch', { convId: C, id: 'w_t1_2', patch: { state } });
    await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() });
    const archived = s.state.work[C].filter((e) => e.kind === 'turn-archive').map((e) => e.turnId);
    assert.deepEqual(archived, ['t2'], 't1 stays hot; t2 goes; t3 and t4 are the last two');
  });

test('I4: a turn whose turn entry still says running stays hot', async () => {
  const s = room();
  s.emit('work.add', { convId: C, entry: { id: 't1', kind: 'turn', turnId: 't1', status: 'running', at: 0, handle: 'researcher' } });
  await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() });
  assert.ok(!s.state.work[C].some((e) => e.kind === 'turn-archive'));
});

test('a restore after archiving works on the file entry, which has no turn and stays hot (critic’s restore point, ledger.mjs:562-590, :689)', async () => {
  const s = room();
  s.emit('work.add', { convId: C, entry: { id: 'wf_a', kind: 'file', path: '/p/a.txt', turns: ['t1'], restored: null, at: 1 } });
  s.emit('work.add', { convId: C, entry: { id: 'wd_a', kind: 'change', fileId: 'wf_a', turnId: 't1', added: 3, deleted: 1, at: 1 } });
  await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() });
  const list = s.state.work[C];
  assert.ok(
    list.some((e) => e.id === 'wf_a'),
    'the file entry is hot',
  );
  assert.ok(!list.some((e) => e.id === 'wd_a'), 't1’s change went to the archive');
  assert.deepEqual(list.find((e) => e.kind === 'turn-archive').counts.lines, { added: 3, removed: 1 });
  s.emit('work.patch', { convId: C, id: 'wf_a', patch: { restored: { at: 99 } } });
  assert.deepEqual(list.find((e) => e.id === 'wf_a').restored, { at: 99 }, 'the restore lands on the hot file entry');
});

test('the summary keeps the turn’s effort, so the conversation’s totals don’t shrink when a turn is archived', async () => {
  const s = room();
  s.emit('work.add', {
    convId: C,
    entry: {
      id: 't1',
      kind: 'turn',
      turnId: 't1',
      status: 'done',
      at: 0,
      handle: 'researcher',
      ms: 5000,
      toolCalls: 7,
      costUsd: 0.25,
      tokens: { input: 10, output: 5 },
    },
  });
  await archiveTurns({ store: s, blobs: memoryBlobs(), convId: C, running: new Set() });
  const sum = s.state.work[C].find((e) => e.kind === 'turn-archive');
  assert.deepEqual(sum.effort, { turns: 1, ms: 5000, toolCalls: 7, costUsd: 0.25, tokens: { input: 10, output: 5 } });
});
