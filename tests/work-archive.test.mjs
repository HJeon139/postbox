// The archive pass (#305; designs/305-archive-turns.md, “Write path”): each agent keeps its last two turns’ work and
// reply activity in the state, and each older ended turn moves to an archive file, published before the turn.archive
// commit that names it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryBlobs } from '../server/ledger-io.mjs';
import { Store } from '../server/store.mjs';
import { addTurn, archived, C, pass, room, summaries, TOPIC } from './work-archive-fixture.mjs';

test('T-1: ending a third turn archives the first, and its file holds its entries and activity byte for byte', async () => {
  const s = room();
  const blobs = memoryBlobs();
  const entries = JSON.stringify(s.state.work[C].filter((e) => e.turnId === 't1'));
  const activity = JSON.stringify(s.state.items[C][0].activity);
  assert.equal(await pass(s, { blobs }), 1);
  const [sum] = summaries(s);
  assert.deepEqual(
    s.state.work[C].map((e) => e.id),
    ['wa_t1', 't2', 'w_t2_1', 'w_t2_2', 't3', 'w_t3_1', 'w_t3_2'],
  );
  const file = JSON.parse((await blobs.get(sum.sha256)).toString());
  assert.deepEqual(Object.keys(file), ['v', 'convId', 'turnId', 'work', 'activity'], 'the file’s shape, which the read side reads');
  assert.deepEqual([file.v, file.convId, file.turnId], [1, C, 't1']);
  assert.equal(JSON.stringify(file.work), entries, 'the entries as they were in the state');
  assert.equal(JSON.stringify(file.activity[C].r_t1), activity, 'the activity, keyed by thread, then reply');
  assert.deepEqual(s.state.items[C][0].activity, { archived: sum.sha256, count: 1 });
});

test('T-1: the summary counts the turn and keeps its effort, so the totals don’t shrink', async () => {
  const s = room();
  await pass(s);
  const [sum] = summaries(s);
  assert.deepEqual(sum.entryIds, ['t1', 'w_t1_1', 'w_t1_2']);
  assert.equal(sum.at, 10, 'the first archived entry’s time');
  assert.deepEqual(sum.counts, { files: 0, lines: { added: 0, removed: 0 }, edits: 0, commands: 2, failed: 0, reads: 0, publishes: 0, steps: 1 });
  assert.deepEqual(sum.effort, { turns: 1, ms: 100, toolCalls: 2, costUsd: 0.01, tokens: 5 });
  assert.deepEqual(sum.handles, ['alpha']);
});

test('T-11: a reply in a topic thread is archived with its turn', async () => {
  const s = room([
    ['t1', 'alpha', TOPIC],
    ['t2', 'alpha'],
    ['t3', 'alpha'],
  ]);
  await pass(s);
  assert.deepEqual(archived(s), ['t1']);
  assert.match(s.state.items[TOPIC][0].activity.archived, /^[a-f0-9]{64}$/, 'the topic’s reply names the archive file');
  assert.equal(s.state.items[C][0].activity.steps.length, 1, 't2’s reply keeps its steps');
});

test('with five ended turns of one agent the pass archives three, oldest first, and stops at its last two', async () => {
  const s = room(['t1', 't2', 't3', 't4', 't5'].map((t) => [t, 'alpha']));
  assert.equal(await pass(s), 3);
  assert.deepEqual(archived(s), ['t1', 't2', 't3']);
});

test('T-21: agent A’s long turn stays hot while B and C each finish three short ones; only their older turns go', async () => {
  const t = new Store(null);
  t.emit('thread', { id: C, members: [] });
  addTurn(t, 'a1', 'alpha', { at: 1 });
  for (const [k, turnId] of ['b1', 'c1', 'b2', 'c2', 'b3', 'c3'].entries()) addTurn(t, turnId, turnId[0] === 'b' ? 'beta' : 'gamma', { at: 10 + k * 10 });
  assert.equal(await pass(t), 2);
  assert.deepEqual(archived(t), ['b1', 'c1'], 'a1 is alpha’s only turn, so it stays, the oldest of all');
  assert.ok(t.state.items[C].find((i) => i.id === 'r_a1').activity.steps, 'alpha’s reply keeps its steps');
});

test('T-17: a reply-only turn is archived with its replies’ activity, in time order, and counts toward its agent’s two', async () => {
  const s = new Store(null);
  s.emit('thread', { id: C, members: [] });
  addTurn(s, 't1', 'alpha', { at: 10 });
  addTurn(s, 'r1', 'beta', { at: 12, work: false }); // its reply at 17
  addTurn(s, 't2', 'beta', { at: 20 });
  addTurn(s, 't3', 'beta', { at: 30 });
  addTurn(s, 't4', 'alpha', { at: 40 });
  addTurn(s, 't5', 'alpha', { at: 50 });
  await pass(s);
  assert.deepEqual(archived(s), ['t1', 'r1'], 'r1 is beta’s oldest of three; t2 and t3 are its last two');
  const ids = s.state.work[C].map((e) => e.id);
  // By its time: after t1’s summary, before t2’s commands, not at the end.
  assert.ok(ids.indexOf('wa_t1') < ids.indexOf('wa_r1') && ids.indexOf('wa_r1') < ids.indexOf('w_t2_1'), ids.join());
  const sum = summaries(s)[1];
  assert.deepEqual([sum.at, sum.entryIds, sum.counts.steps], [17, [], 1], 'its time is its reply’s');
  assert.equal(s.state.items[C].find((i) => i.id === 'r_r1').activity.count, 1);
});

test('T-13: a change to a removed field while the file is put stops the archive, and the commit writes nothing', async () => {
  for (const change of [
    (/** @type {Store} */ s) => s.emit('work.patch', { convId: C, id: 'w_t2_1', patch: { output: 'a background command finished' } }),
    (/** @type {Store} */ s) => s.emit('item.patch', { threadId: TOPIC, id: 'r_t2', activityStep: { id: 's1', detail: 'changed' } }),
  ]) {
    const s = room(['t1', 't2', 't3', 't4'].map((t) => [t, 'alpha', t === 't2' ? TOPIC : C]));
    const blobs = memoryBlobs();
    let puts = 0;
    const late = {
      get: blobs.get,
      put: async (/** @type {Buffer} */ buf) => {
        const r = await blobs.put(buf);
        if (puts++ === 1) change(s); // t2’s file is out; then its state changes
        return r;
      },
    };
    const seq = s.state.seq;
    assert.equal(await pass(s, { blobs: late, chunk: 1 }), 1, 't1 went before the change');
    assert.deepEqual(archived(s), ['t1'], 't2 stays hot: the state no longer holds what its file holds');
    assert.equal(s.state.seq, seq + 2, 't1’s archive and the change, nothing for t2');
  }
});

test('a commit answered duplicate stops the pass rather than committing the same turn again', async () => {
  const s = room();
  let calls = 0;
  const store = Object.assign(Object.create(s), {
    commit: async () => {
      calls++;
      return { seq: s.state.seq, duplicate: true };
    },
  });
  assert.equal(await pass(store), 0);
  assert.equal(calls, 1);
});

test('the pass asks canWrite before each file, so one that sees the store close puts nothing more', async () => {
  const s = room(['t1', 't2', 't3', 't4', 't5'].map((t) => [t, 'alpha']));
  const blobs = memoryBlobs();
  let puts = 0;
  const counted = {
    get: blobs.get,
    put: (/** @type {Buffer} */ b) => {
      puts++;
      return blobs.put(b);
    },
  };
  assert.equal(await pass(s, { blobs: counted, canWrite: () => puts === 0 }), 1);
  assert.equal(puts, 1, 'no file after canWrite turned false');
});

test('a closed store rejects the commit, and the pass gives up with it rather than retrying', async () => {
  const s = room();
  let calls = 0;
  const closed = Object.assign(new Error('The store is closed to writes.'), { code: 'ECLOSED' });
  const store = Object.assign(Object.create(s), {
    commit: async () => {
      calls++;
      throw closed;
    },
  });
  await assert.rejects(pass(store), (e) => e === closed);
  assert.equal(calls, 1, 'one try');
  assert.deepEqual(archived(s), []);
});
