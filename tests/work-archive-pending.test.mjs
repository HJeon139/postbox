// T-16’s pending-view part (#305; designs/305-archive-turns.md, “Held emits and the pending read”): turn.archive is a
// commit, never an emit, so the pending view (server/store-held.mjs) never holds one. While the pass’s commit is in
// flight, the pending read still shows the turn, and what the pending readers decide on, the kept entries and the
// newest turns, reads the same before, during and after it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldStore, until } from './stop-reply-fixture.mjs';
import { C, pass, room } from './work-archive-fixture.mjs';

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
