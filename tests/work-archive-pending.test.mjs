// T-16’s pending-view part (#305; designs/305-archive-turns.md, “Held emits and the pending read”): turn.archive touches
// work and items, so the pending view (server/store-held.mjs) applies a held one to both lists, reading the work list
// back from the state since the reducer replaces the array, and never changes a published reply. While the pass’s own
// commit is in flight, the pending read still shows the turn, and what the pending readers decide on, the kept entries
// and the newest turns, reads the same before, during and after it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldStore, until } from './stop-reply-fixture.mjs';
import { C, pass, room, TOPIC } from './work-archive-fixture.mjs';

const SHA = 'a'.repeat(64);
/** t1’s archive, as the pass would commit it: its three entries, and its reply in the conversation. */
const ARCHIVE = {
  convId: C,
  turnId: 't1',
  sha256: SHA,
  summary: {
    id: 'wa_t1',
    kind: 'turn-archive',
    turnId: 't1',
    at: 10,
    sha256: SHA,
    entryIds: ['t1', 'w_t1_1', 'w_t1_2'],
    counts: {},
    effort: {},
    handles: ['alpha'],
  },
  items: [{ threadId: C, id: 'r_t1' }],
};

/** A heldStore with three turns of alpha’s, and a commit in front held in its fsync, so emits from now on are held. */
async function holding() {
  const h = await heldStore();
  room(undefined, h.store);
  await h.store.flush();
  h.hold();
  const front = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  return { ...h, front };
}
const ids = (/** @type {readonly any[]} */ list) => list.map((e) => e.id);

test('T-16: a held turn.archive is in the pending work and items, and the published lists are untouched', async () => {
  const { store, release, front } = await holding();
  const published = store.state.work[C];
  const reply = store.state.items[C][0];
  const steps = JSON.stringify(reply.activity);
  store.pending.work(C); // a view made before the event must take it in too
  store.emit('turn.archive', ARCHIVE);
  assert.deepEqual(ids(store.pending.work(C)), ['wa_t1', 't2', 'w_t2_1', 'w_t2_2', 't3', 'w_t3_1', 'w_t3_2']);
  assert.deepEqual(store.pending.item(C, 'r_t1').activity, { archived: SHA, count: 1 });
  assert.equal(store.pending.items(TOPIC).find((i) => i.id === 'r_t2').activity.steps.length, 1, 'another thread’s reply is as it was');
  assert.equal(store.state.work[C], published, 'the published array is the same one');
  assert.equal(published.length, 9);
  assert.equal(JSON.stringify(reply.activity), steps, 'the published reply keeps its steps until the release');
  release();
  await front;
  await store.flush();
  assert.deepEqual(ids(store.state.work[C]), ['wa_t1', 't2', 'w_t2_1', 'w_t2_2', 't3', 'w_t3_1', 'w_t3_2'], 'what was pending is published');
  await store.close();
});

test('T-16: a held work.patch after a held turn.archive patches the new array’s entries, as the release will', async () => {
  const { store, release, front } = await holding();
  store.emit('turn.archive', ARCHIVE);
  store.emit('work.patch', { convId: C, id: 'w_t2_1', patch: { output: 'later' } });
  store.emit('work.patch', { convId: C, id: 'w_t1_1', patch: { output: 'gone' } });
  const pending = store.pending.work(C);
  assert.equal(pending.find((e) => e.id === 'w_t2_1').output, 'later');
  assert.ok(!pending.some((e) => e.id === 'w_t1_1'), 'a patch for a moved entry resurrects nothing');
  assert.equal(store.state.work[C].find((e) => e.id === 'w_t2_1').output, undefined, 'the published entry is untouched');
  release();
  await front;
  await store.flush();
  assert.equal(JSON.stringify(store.state.work[C]), JSON.stringify(pending));
  await store.close();
});

test('T-16: while the pass’s commit is in flight, what pending readers decide on reads the same before, during and after', async () => {
  const h = await heldStore();
  const { store } = h;
  room(undefined, store);
  store.emit('work.add', {
    convId: C,
    entry: { id: 'wx1', kind: 'external', via: 'gh', what: 'gh pr create', state: 'done', urls: ['u'], turnId: 't1', at: 13 },
  });
  await store.flush();
  const decided = () => store.pending.work(C).filter((e) => e.kind === 'external' || e.turnId === 't2' || e.turnId === 't3');
  const before = JSON.stringify(decided());
  h.hold();
  const run = pass(store);
  await h.atSync;
  await until(() => store.waitingCommits === 1, 'the archive commit in its fsync');
  store.emit('work.patch', { convId: C, id: 'w_t3_1', patch: { output: 'held' } });
  const during = decided();
  assert.equal(during.find((e) => e.id === 'w_t3_1').output, 'held', 'a held patch to a hot entry is seen');
  h.release();
  assert.equal(await run, 1);
  await store.flush();
  assert.equal(JSON.stringify(decided()), JSON.stringify(during), 'the release published what was pending for them');
  assert.notEqual(before, JSON.stringify(during));
  await store.close();
});
