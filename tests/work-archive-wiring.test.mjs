// The archive pass wired into the runtime (#305; design-305-wiring-1): after a turn’s work is recorded, the pass runs
// for its conversation through one chain per conversation (W4), out of the turn’s path (W1); a failure is logged once
// and the chain goes on (W2); a closed store is skipped (W3).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup as plainSetup, settle, sleep } from './side-threads-fixture.mjs';

/** A runtime with the archive passes on: they are off by default (server/archive-runtime.mjs). */
function setup() {
  const ctx = plainSetup();
  ctx.rt.turnArchive.enabled = true;
  return ctx;
}

/** Three turns for @alpha in the conversation, one after another. */
async function threeTurns() {
  const ctx = setup();
  for (const n of [1, 2, 3]) {
    ctx.rt.sendMessage(ctx.t.id, { text: `@alpha turn ${n}` });
    await settle(ctx.rt);
  }
  await ctx.rt.turnArchive.idle(ctx.t.id);
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
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    for (const n of [1, 2, 3]) {
      rt.sendMessage(t.id, { text: `@alpha turn ${n}` });
      await settle(rt);
    }
    await rt.turnArchive.idle(t.id);
    assert.equal(lines.filter((l) => /archive/i.test(l)).length, 1, 'one line for the failed run');
    assert.match(
      lines.find((l) => /archive/i.test(l)),
      /disk said no/,
    );
    assert.equal(summaries(store, t.id).length, 0);
    fail = false;
    rt.sendMessage(t.id, { text: '@alpha turn 4' });
    await settle(rt);
    await rt.turnArchive.idle(t.id);
    assert.equal(summaries(store, t.id).length, 2, 'the next turn end archives both older turns');
    await sleep(5);
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
  } finally {
    console.warn = warn;
    process.off('unhandledRejection', onUnhandled);
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
    await rt.turnArchive.idle(t.id);
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
  await Promise.all([rt.turnArchive.conversation(t.id), rt.turnArchive.conversation(t.id), rt.turnArchive.conversation(t.id)]);
  await rt.turnArchive.idle(t.id);
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
  await rt.turnArchive.all();
  for (const c of convs)
    assert.deepEqual(
      summaries(store, c.id).map((e) => e.turnId),
      ['t1'],
    );
});

/** Two turns, then a third whose pass holds at its put until released. */
async function heldPut() {
  const ctx = setup();
  const { rt, t } = ctx;
  for (const n of [1, 2]) {
    rt.sendMessage(t.id, { text: `@alpha turn ${n}` });
    await settle(rt);
  }
  const put = rt.ledger.blobs.put.bind(rt.ledger.blobs);
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => {
    release = () => r(null);
  });
  let puts = 0;
  rt.ledger.blobs.put = async (b) => {
    puts++;
    await gate;
    return put(b);
  };
  rt.sendMessage(t.id, { text: '@alpha turn 3' });
  await settle(rt);
  return { ...ctx, release, puts: () => puts };
}

test('W5: shutdown ends the archive chains before the store closes: no put after close, no line logged (critic’s probe)', async () => {
  const { rt, store, release, puts } = await heldPut();
  assert.equal(puts(), 1, 'a pass is holding at its put');
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    await rt.stopTurns();
    const stopping = rt.turnArchive.stop();
    release();
    await stopping;
    const before = puts();
    await store.close();
    rt.turnArchive.conversation(Object.keys(store.state.threads)[0]);
    await sleep(10);
    assert.equal(puts(), before, 'nothing is put after the store closed');
    assert.deepEqual(lines, [], 'shutdown is not a failure to report');
  } finally {
    console.warn = warn;
  }
});

test('W5 bounded: a put that hangs doesn’t stop shutdown; stopArchiving gives up at its bound with one line', async () => {
  const { rt, puts } = await heldPut();
  assert.equal(puts(), 1);
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    const started = Date.now();
    await rt.turnArchive.stop(50);
    assert.ok(Date.now() - started < 1000, 'shutdown went on');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /archive/i);
  } finally {
    console.warn = warn;
  }
});

test('off by default: with no config flag, ending a third turn archives nothing and puts no file', async () => {
  const { rt, store, t } = plainSetup();
  assert.equal(rt.turnArchive.enabled, false);
  let puts = 0;
  const put = rt.ledger.blobs.put.bind(rt.ledger.blobs);
  rt.ledger.blobs.put = (b) => {
    puts++;
    return put(b);
  };
  for (const n of [1, 2, 3]) {
    rt.sendMessage(t.id, { text: `@alpha turn ${n}` });
    await settle(rt);
  }
  await rt.turnArchive.all();
  assert.equal(summaries(store, t.id).length, 0);
  assert.equal(puts, 0);
  assert.equal(store.state.work[t.id].filter((e) => e.kind === 'turn').length, 3, 'every turn stays live');
});

test('a conversation being deleted is skipped by the turn-end pass as well as the start-up one', async () => {
  const { rt, store, t } = setup();
  for (const n of [1, 2]) {
    rt.sendMessage(t.id, { text: `@alpha turn ${n}` });
    await settle(rt);
  }
  rt.deleteThread(t.id);
  store.emit('work.add', { convId: t.id, entry: { id: 'w_extra', turnId: 't_extra', kind: 'command', state: 'done', at: Date.now() } });
  assert.equal(await rt.turnArchive.conversation(t.id), 0);
  assert.equal(summaries(store, t.id).length, 0);
  rt.undoDeleteThread(t.id);
});
