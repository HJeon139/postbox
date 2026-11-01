// Each held wake message has one owner after Retry, decided by the recovered state (S1; gpt’s and critic’s reads of
// #598 at e0a1a4a3). A wake waits in four places: a held start (heldTurn), a turn’s pending list, a stopped turn’s exit,
// and a deleting agent’s Undo hold (#597). The re-arm owns an automatic wake, and a manual Retry whose schedule the
// recovered state still holds; a manual Retry whose schedule is gone has no other owner, and is the person’s own action.
// The first two specs are gpt’s probes. The same real Postbox setup on its own port.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { cancelWakeSchedule, fireScheduledWake } from '../server/scheduled-wakes.mjs';
import { heldTurn } from '../server/store-outage.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4447;
const eio = () => Object.assign(new Error('disk sync refused'), { code: 'EIO' });
let app;
let dir;
let rt;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-wake-owners-'));
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
  rt = app.rt;
  rt.store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  await rt.store.flush();
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  if (!rt.store.writable) await rt.store.reload();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits for a condition, up to 5 s. @param {() => boolean} pred @param {string} what */
const until = async (pred, what) => {
  for (let i = 0; i < 200 && !pred(); i++) await sleep(25);
  assert.ok(pred(), `waited for ${what}`);
};

/** An agent whose first turn stays busy until the outage stops it; the calls it got. */
async function busyAgent(handle) {
  const calls = [];
  rt.adapters.register({
    name: `busy-${handle}`,
    async deliver(_se, message, ctx) {
      calls.push(message);
      if (calls.length === 1) await new Promise((r) => ctx.signal.addEventListener('abort', () => r(undefined), { once: true }));
    },
  });
  const p = rt.createPersona({ handle, backend: `busy-${handle}` });
  const t = rt.createThread({ projectId: 'p1', title: handle, personaIds: [p.id] });
  const [se] = rt.sessionsIn(t.id);
  await rt.store.flush();
  rt.sendMessage(t.id, { text: `@${handle} work` });
  await until(() => calls.length === 1 && rt.turns.has(se.id), 'the busy turn');
  return { se, calls };
}
/** The outage stops the busy turn, and Retry runs to the end. */
async function outageAndRetry(se) {
  await rt.store.flush();
  rt.store.fail(eio());
  await until(() => !rt.turns.has(se.id), 'the outage to stop the turn');
  await rt.store.reload();
}
const wakes = (calls, id) => calls.filter((m) => m.scheduledWakeId === id).length;

test('a wake held for a deleting agent’s Undo, across Retry, then Undo: one delivery, not two (gpt’s probe)', async () => {
  const calls = [];
  rt.adapters.register({
    name: 'undo-wake',
    async deliver(_se, message) {
      calls.push(message);
    },
  });
  const p = rt.createPersona({ handle: 'undowake', backend: 'undo-wake' });
  const t = rt.createThread({ projectId: 'p1', title: 'Undo wake', personaIds: [p.id] });
  const [se] = rt.sessionsIn(t.id);
  const sc = rt.schedule(se.id, { inMs: 1000, note: 'one wake' });
  rt.deleteSession(se.id);
  fireScheduledWake(rt, sc.id); // held for the Undo window, the schedule running
  await rt.store.flush();
  assert.equal(rt.heldForUndo.get(se.id)?.length, 1);
  rt.store.fail(eio());
  await rt.store.reload(); // the re-arm fires the same wake again at once; it is held again
  await until(() => !rt.timers.has(sc.id), 'the re-armed wake to fire');
  rt.undoDelete(se.id);
  await until(() => wakes(calls, sc.id) >= 1, 'the wake after Undo');
  await sleep(200);
  assert.equal(wakes(calls, sc.id), 1, `one delivery after Undo, not ${wakes(calls, sc.id)}`);
  await rt.store.flush();
});

test('a manual Retry behind a busy turn, its schedule gone, is delivered once after Retry: it has no other owner (gpt’s probe)', async () => {
  const { se, calls } = await busyAgent('manualgone');
  rt.deliver(se.id, { kind: 'wake', scheduledWakeId: 'sc_finished', retry: true, note: 'you asked to retry' });
  assert.equal(rt.turns.get(se.id).pending.length, 1);
  await outageAndRetry(se);
  await until(() => wakes(calls, 'sc_finished') >= 1, 'the person’s Retry to be delivered');
  await sleep(200);
  assert.equal(wakes(calls, 'sc_finished'), 1);
  await rt.store.flush();
});

test('a manual Retry behind a busy turn, its schedule still there, is delivered once after Retry, by the re-arm', async () => {
  const { se, calls } = await busyAgent('manualhere');
  const sc = rt.schedule(se.id, { inMs: 60_000, note: 'later' });
  rt.deliver(se.id, { kind: 'wake', scheduledWakeId: sc.id, retry: true, note: 'you asked to retry' }); // takes it from the timer
  assert.equal(rt.s.schedules[sc.id]?.running, true);
  await outageAndRetry(se); // the re-arm finds it running and runs it again
  await until(() => wakes(calls, sc.id) >= 1, 'the wake after Retry');
  await sleep(300);
  assert.equal(wakes(calls, sc.id), 1, `one delivery, not ${wakes(calls, sc.id)}`);
  await rt.store.flush();
});

test('an automatic wake behind a busy turn whose schedule was canceled is not delivered after Retry', async () => {
  const { se, calls } = await busyAgent('autogone');
  const sc = rt.schedule(se.id, { inMs: 30, note: 'canceled' });
  await until(() => rt.s.schedules[sc.id]?.running, 'the wake to fire and wait behind the busy turn');
  cancelWakeSchedule(rt, sc.id); // the recovered state holds no schedule
  await outageAndRetry(se);
  await until(() => !rt.turns.has(se.id) && !rt.exiting.has(se.id), 'every turn to end');
  await sleep(300);
  assert.equal(wakes(calls, sc.id), 0);
  await rt.store.flush();
});

test('a held start keeps the person’s Retry whose schedule is gone, and drops a wake the re-arm owns', async () => {
  const p = rt.createPersona({ handle: 'heldstart' });
  const t = rt.createThread({ projectId: 'p1', title: 'Held start', personaIds: [p.id] });
  const [se] = rt.sessionsIn(t.id);
  await rt.store.flush();
  rt.store.fail(eio());
  const ran = [];
  heldTurn(rt, se.id, () => ran.push('auto'), { kind: 'wake', scheduledWakeId: 'sc_gone_auto' });
  heldTurn(rt, se.id, () => ran.push('retry'), { kind: 'wake', scheduledWakeId: 'sc_gone_retry', retry: true });
  heldTurn(rt, se.id, () => ran.push('message'), { kind: 'message', text: 'hi' });
  await rt.store.reload();
  assert.deepEqual(ran, ['retry', 'message'], 'the automatic wake is dropped; the Retry and the plain message run once');
});
