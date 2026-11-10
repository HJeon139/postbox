// I4, only finished turns (#305; designs/305-archive-turns.md, “Invariants”): a turn the runtime lists as running or
// with a kept job, one whose `turn` entry still says running, and one with an entry in a state the ledger can still
// move it out of, stay hot. Each is passed over, not waited on: later ended turns are archived past it (T-3, T-20).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archived, C, pass, room } from './work-archive-fixture.mjs';

const four = () => room(['t1', 't2', 't3', 't4'].map((t) => [t, 'alpha']));

test('T-3: a turn the runtime lists as live, running or with a kept job, is never archived', async () => {
  const s = four();
  await pass(s, { running: new Set(['t1']) });
  assert.deepEqual(archived(s), ['t2'], 't1 stays hot; t2 goes; t3 and t4 are the last two');
});

test('T-3: the runtime’s list is read for each turn, so a turn kept running mid-pass is passed over', async () => {
  const s = room(['t1', 't2', 't3', 't4', 't5'].map((t) => [t, 'alpha']));
  let busy = new Set();
  const store = Object.assign(Object.create(s), {
    commit: async (/** @type {any} */ fn, /** @type {any} */ o) => {
      const r = await s.commit(fn, o);
      busy = new Set(['t2']); // a job of t2’s is kept running while t1 is committed
      return r;
    },
  });
  await pass(store, { running: () => busy, chunk: 1 });
  assert.deepEqual(archived(s), ['t1', 't3']);
});

for (const state of ['running', 'background', 'unknown'])
  test(`T-20: a command left ${state} keeps its turn hot, and later ended turns are archived past it`, async () => {
    const s = four();
    s.emit('work.patch', { convId: C, id: 'w_t1_2', patch: { state } });
    await pass(s);
    assert.deepEqual(archived(s), ['t2']);
  });

test('T-20: a turn whose turn entry still says running stays hot', async () => {
  const s = four();
  s.emit('work.patch', { convId: C, id: 't1', patch: { status: 'running' } });
  await pass(s);
  assert.deepEqual(archived(s), ['t2']);
});

test('T-20: the final states, done, failed, stopped and denied, let a turn go', async () => {
  const s = four();
  for (const [id, state] of [
    ['w_t1_1', 'failed'],
    ['w_t1_2', 'stopped'],
    ['w_t2_1', 'denied'],
  ])
    s.emit('work.patch', { convId: C, id, patch: { state } });
  await pass(s);
  assert.deepEqual(archived(s), ['t1', 't2']);
});

test('T-3: a turn that starts running while its file is put is not committed: the commit reads the runtime again', async () => {
  const s = four();
  let busy = new Set();
  const store = Object.assign(Object.create(s), {
    commit: (/** @type {any} */ fn, /** @type {any} */ o) => {
      busy = new Set(['t1']); // between the put and the commit’s sequencing
      return s.commit(fn, o);
    },
  });
  await pass(store, { running: () => busy, chunk: 1 });
  assert.deepEqual(archived(s), [], 't1 is live when its commit is sequenced, so the pass stops there');
});
