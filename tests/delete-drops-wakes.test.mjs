// #1670: deleting a conversation, or one agent from a room, left the agents' scheduled wakes behind until each fired
// and found its session gone. Until then the public state named a session and a conversation that no longer existed,
// and a timer ran for it. Each wake now goes with its session.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './side-threads-fixture.mjs';
import { setup as heldSetup, heldStore } from './stop-reply-fixture.mjs';

test('#1670 deleting a conversation cancels its agents’ wakes at once, with their timers', () => {
  const f = setup();
  const a = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check the run.' });
  const b = f.rt.schedule(f.beta.id, { inMs: 60_000, note: 'Read the review.' });
  f.rt.deleteThread(f.t.id);
  for (const sc of [a, b]) {
    assert.equal(f.store.state.schedules[sc.id], undefined, `${sc.handle}’s wake is gone`);
    assert.equal(f.rt.timers.has(sc.id), false, `and its timer, so it never fires`);
  }
});

test('#1670 removing one agent from a room cancels its wakes and keeps the other agent’s', () => {
  const f = setup();
  const a = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Check the run.' });
  const b = f.rt.schedule(f.beta.id, { inMs: 60_000, note: 'Read the review.' });
  f.rt.deleteSession(f.alpha.id);
  assert.equal(f.store.state.schedules[a.id], undefined, 'the removed agent’s wake is gone');
  assert.equal(f.rt.timers.has(a.id), false);
  const line = f.store.items(f.t.id).find((x) => x.kind === 'system' && x.scheduleId === a.id);
  assert.equal(line?.status, 'canceled', 'its line in the room reads canceled');
  assert.ok(f.store.state.schedules[b.id], 'the other agent’s wake stays');
  assert.ok(f.rt.timers.has(b.id));
});

test('#1670 a wake scheduled behind a held commit goes with its conversation', async () => {
  const h = await heldStore();
  const env = await heldSetup(async () => {}, h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  const sc = env.rt.schedule(env.se.id, { inMs: 60_000, note: 'check the gate' });
  env.rt.deleteThread(env.se.threadId);
  const timer = env.rt.timers.has(sc.id);
  h.release();
  await commit;
  await h.store.flush();
  assert.equal(timer, false, 'its timer went at the delete');
  assert.equal(h.store.state.schedules[sc.id], undefined, 'and its schedule');
  await h.store.close();
});
