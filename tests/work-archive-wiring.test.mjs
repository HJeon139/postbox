// The archive pass wired into the runtime (#305; design-305-wiring-1): after a turn’s work is recorded, the pass runs
// for its conversation through one chain per conversation (W4), out of the turn’s path (W1); a failure is logged once
// and the chain goes on (W2); a closed store is skipped (W3).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup, sleep } from './side-threads-fixture.mjs';

/** Three turns for @alpha in the conversation, one after another. */
async function threeTurns() {
  const ctx = setup();
  for (const n of [1, 2, 3]) {
    ctx.rt.sendMessage(ctx.t.id, { text: `@alpha turn ${n}` });
    await settle(ctx.rt);
  }
  await ctx.rt.archiveIdle?.(ctx.t.id);
  return ctx;
}
const summaries = (store, convId) => (store.state.work[convId] ?? []).filter((e) => e.kind === 'turn-archive');

test('T-W1: ending a third turn archives the first, through the runtime', async () => {
  const { store, t } = await threeTurns();
  assert.equal(summaries(store, t.id).length, 1);
  const turnEntries = store.state.work[t.id].filter((e) => e.kind === 'turn');
  assert.equal(turnEntries.length, 2, 'the last two turns stay hot');
});

test('T-W2: a rejected commit is logged once, the chain settles, and the next turn end archives', async () => {
  const ctx = setup();
  const { rt, store, t } = ctx;
  const commit = store.commit.bind(store);
  let fail = true;
  store.commit = (...a) => (fail ? Promise.reject(Object.assign(new Error('disk said no'), { code: 'EIO' })) : commit(...a));
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    for (const n of [1, 2, 3]) {
      rt.sendMessage(t.id, { text: `@alpha turn ${n}` });
      await settle(rt);
    }
    await rt.archiveIdle(t.id);
    assert.equal(lines.filter((l) => /archive/i.test(l)).length, 1, 'one line for the failed run');
    assert.match(
      lines.find((l) => /archive/i.test(l)),
      /disk said no/,
    );
    assert.equal(summaries(store, t.id).length, 0);
    fail = false;
    rt.sendMessage(t.id, { text: '@alpha turn 4' });
    await settle(rt);
    await rt.archiveIdle(t.id);
    assert.equal(summaries(store, t.id).length, 2, 'the next turn end archives both older turns');
  } finally {
    console.warn = warn;
  }
});

test('T-W3: with the store closed to writes, the pass puts nothing and logs nothing', async () => {
  const ctx = setup();
  const { rt, store, t } = ctx;
  let puts = 0;
  const put = rt.ledger.blobs.put.bind(rt.ledger.blobs);
  rt.ledger.blobs.put = (b) => {
    puts++;
    return put(b);
  };
  for (const n of [1, 2]) {
    rt.sendMessage(t.id, { text: `@alpha turn ${n}` });
    await settle(rt);
  }
  store.writable = false;
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    rt.sendMessage(t.id, { text: '@alpha turn 3' });
    await settle(rt);
    await rt.archiveIdle(t.id);
  } finally {
    console.warn = warn;
    store.writable = true;
  }
  assert.equal(puts, 0);
  assert.equal(lines.filter((l) => /archive/i.test(l)).length, 0);
});

test('T-W4: back-to-back runs for one conversation archive each turn once', async () => {
  const { rt, store, t } = await threeTurns();
  rt.sendMessage(t.id, { text: '@alpha turn 4' });
  await settle(rt);
  await Promise.all([rt.archiveConversation(t.id), rt.archiveConversation(t.id), rt.archiveConversation(t.id)]);
  await rt.archiveIdle(t.id);
  const ids = summaries(store, t.id).map((e) => e.turnId);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, 'no turn archived twice');
  await sleep(1);
});

test('T-9 (unit): after start, archiveAll archives every conversation’s older turns, one conversation at a time', async () => {
  const { rt, store } = setup();
  const convs = ['A', 'B'].map((n) => rt.createThread({ projectId: 'p1', title: `Existing ${n}`, personaIds: [] }));
  for (const c of convs)
    for (const [k, turnId] of ['t1', 't2', 't3'].entries())
      store.emit('work.add', { convId: c.id, entry: { id: `w_${c.id}_${turnId}`, turnId, kind: 'command', command: 'ls', state: 'done', at: k + 1 } });
  await rt.archiveAll();
  for (const c of convs)
    assert.deepEqual(
      summaries(store, c.id).map((e) => e.turnId),
      ['t1'],
    );
});
