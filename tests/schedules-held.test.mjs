// #623: reads of schedules that decide a write read what is held behind a commit too (designs/508/601-held-view.md).
// Schedules had no pending read. A wake scheduled while a commit was held was emitted, then armWake read it back from
// the published state, found nothing, and set no timer: the wake never fired until Postbox restarted. Canceling one
// scheduled in the same window answered “already happened”, and the per-agent limit didn’t count it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelWake, scheduleWakeTool } from '../server/schedule-tools.mjs';
import { fireScheduledWake, prepareScheduledRetry } from '../server/scheduled-wakes.mjs';
import { PENDING_WAKES } from '../shared/limits.mjs';
import { heldStore, setup } from './stop-reply-fixture.mjs';

/** A runtime on a store whose next commit is held, with fn run, and awaited, while it is (conversations-held.test.mjs). */
async function whileHeld(fn) {
  const h = await heldStore();
  const env = await setup(async () => {}, h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  let result;
  try {
    result = await fn(env);
  } finally {
    h.release();
    await commit;
    await h.store.flush();
  }
  return { env, result, store: h.store };
}

test('#623: a wake scheduled while a commit is held is armed', async () => {
  const { env, result, store } = await whileHeld(({ rt, se }) => {
    const sc = rt.schedule(se.id, { inMs: 60_000, note: 'check the gate' });
    return { sc, armed: rt.timers.has(sc.id) };
  });
  assert.equal(result.armed, true, 'its timer was set');
  assert.ok(store.state.schedules[result.sc.id], 'and it was written');
  clearTimeout(env.rt.timers.get(result.sc.id));
  await store.close();
});

test('#623: a wake scheduled while a commit is held can be canceled, and counts toward the limit', async () => {
  const { env, result, store } = await whileHeld(({ rt, se }) => {
    const first = rt.schedule(se.id, { inMs: 60_000, note: 'one' });
    const pendingNow = Object.values(rt.store.pending.schedules()).filter((x) => x.sessionId === se.id).length;
    const canceled = cancelWake(rt, se.id, { id: first.id });
    return { first, pendingNow, canceled, gone: rt.store.pending.schedule(first.id) === undefined };
  });
  assert.equal(result.pendingNow, 1);
  assert.equal(result.canceled.ok, true, result.canceled.message);
  assert.equal(result.gone, true, 'its removal is read as written too');
  assert.equal(store.state.schedules[result.first.id], undefined, 'it was canceled');
  for (const t of env.rt.timers.values()) clearTimeout(t);
  await store.close();
});

test('#623: the per-agent wake limit counts wakes scheduled behind a held commit', async () => {
  const { env, result, store } = await whileHeld(({ rt, se }) => {
    const answers = [];
    for (let i = 0; i <= PENDING_WAKES; i++) answers.push(scheduleWakeTool(rt, se.id, { in_minutes: 5 + i, note: `n${i}` }));
    return answers;
  });
  assert.equal(result.filter((a) => a.ok).length, PENDING_WAKES, 'past the limit, the next is refused');
  for (const t of env.rt.timers.values()) clearTimeout(t);
  await store.close();
});

test('#623: a wake scheduled behind a held commit fires when it’s due', async () => {
  const { env, result, store } = await whileHeld(({ rt, se }) => {
    const sc = rt.schedule(se.id, { inMs: 60_000, note: 'check the gate' });
    clearTimeout(rt.timers.get(sc.id));
    fireScheduledWake(rt, sc.id);
    return { sc, se };
  });
  assert.ok(
    (store.state.inbox[result.se.id] ?? []).some((e) => e.source === 'scheduled' && e.message?.scheduledWakeId === result.sc.id),
    'its wake went to the agent',
  );
  for (const t of env.rt.timers.values()) clearTimeout(t);
  await store.close();
});

test('#623: a Retry of a wake canceled behind a held commit sends the recovery its line kept, as written', async () => {
  // Critic’s review of PR #1578: with the cancel and the line’s recovery note both held, Retry read the line from the
  // published items and sent the old instruction, which a tool may already have acted on.
  const { env, result, store } = await whileHeld(({ rt, se }) => {
    const sc = rt.schedule(se.id, { inMs: 60_000, note: 'deploy the fix' });
    rt.threads.patchItem(sc.threadId, sc.itemId, { recoveryNote: 'Check what the deploy changed before you continue.' });
    rt.cancelSchedule(sc.id);
    return prepareScheduledRetry(rt, { retry: true, scheduledWakeId: sc.id, note: 'deploy the fix' }, sc.threadId);
  });
  assert.equal(result.note, 'Check what the deploy changed before you continue.');
  for (const t of env.rt.timers.values()) clearTimeout(t);
  await store.close();
});
