// A scheduled wake across an outage has one owner after Retry (S1; the integrator’s re-review of #598 at 1888d7f3), and a
// deleted agent’s queued message is released once (#597, which landed first, so its outage case lands here).
// A wake that fired while its agent was busy waits in turn.pending; the outage’s stop moves it into exiting.held, and
// the reload re-arms the same schedule from the recovered state. Unless the reload drops the held copy, the wake is
// delivered twice: two paid turns where a restart delivers it once. The same real Postbox setup on its own port.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4446;
const eio = () => Object.assign(new Error('disk sync refused'), { code: 'EIO' });
let app;
let dir;
let rt;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-outage-wakes-'));
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

test('a wake queued behind a busy turn when the outage hits is delivered once after Retry (the integrator’s wake-queued)', async () => {
  const calls = [];
  rt.adapters.register({
    name: 'busy-wake',
    async deliver(_se, message, ctx) {
      calls.push(message);
      // The first turn stays busy until the outage stops it; later ones last long enough for the re-armed timer to fire
      // while they run, as a real turn does (the integrator’s repro).
      if (calls.length === 1) await new Promise((r) => ctx.signal.addEventListener('abort', () => r(undefined), { once: true }));
      else await sleep(300);
    },
  });
  const p = rt.createPersona({ handle: 'busywaker', backend: 'busy-wake' });
  const t = rt.createThread({ projectId: 'p1', title: 'Busy', personaIds: [p.id] });
  const [se] = rt.sessionsIn(t.id);
  await rt.store.flush();
  rt.sendMessage(t.id, { text: '@busywaker work' });
  await until(() => calls.length === 1 && rt.turns.has(se.id), 'the busy turn');
  const sc = rt.schedule(se.id, { inMs: 30, note: 'queued' }); // a wake waits at least 1 s
  await until(() => rt.s.schedules[sc.id]?.running, 'the wake to fire and wait behind the busy turn');
  assert.equal(calls.length, 1, 'the wake is queued, not delivered');
  await rt.store.flush(); // the schedule is running on disk
  rt.store.fail(eio()); // the outage stops the busy turn; its queued wake moves into the exit’s held list
  await until(() => !rt.turns.has(se.id), 'the busy turn to stop');
  await rt.store.reload(); // the re-arm finds the schedule running and re-arms it as due
  await until(() => calls.some((m) => m.scheduledWakeId === sc.id), 'the wake after Retry');
  await until(() => !rt.turns.has(se.id) && !rt.exiting.has(se.id), 'every turn and anything held behind it to end');
  await sleep(150);
  const wakes = calls.filter((m) => m.scheduledWakeId === sc.id).length;
  assert.equal(wakes, 1, `one delivery for one wake, not ${wakes}`);
  await rt.store.flush();
});

test('a second outage during the drain after Retry leaves no session mid-turn with no turn: the next reload resets it, as a restart does (the integrator’s outage-in-drain)', async () => {
  rt.adapters.register({
    name: 'drain-busy',
    async deliver(_se, _message, ctx) {
      await new Promise((r) => ctx.signal.addEventListener('abort', () => r(undefined), { once: true }));
    },
  });
  const p = rt.createPersona({ handle: 'draincase', backend: 'drain-busy' });
  const t = rt.createThread({ projectId: 'p1', title: 'Drain', personaIds: [p.id] });
  const [se] = rt.sessionsIn(t.id);
  await rt.store.flush();
  rt.sendMessage(t.id, { text: '@draincase work' });
  await until(() => rt.turns.has(se.id) && ['think', 'gen', 'tool'].includes(rt.s.sessions[se.id].state), 'the turn running');
  await rt.store.flush(); // the session is mid-turn on disk
  rt.store.fail(eio());
  await until(() => !rt.turns.has(se.id), 'the outage to stop the turn');
  // The first Retry reopens, and the drain’s writes are lost to a second failure at once.
  const off = rt.store.onStatus((st) => {
    if (st.writable) {
      off();
      rt.store.fail(eio());
    }
  });
  await rt.store.reload();
  assert.equal(rt.store.writable, false, 'the second outage closed writes again');
  await until(() => !rt.exiting.has(se.id), 'the stopped turn to exit');
  await rt.store.reload(); // the second Retry
  await until(() => rt.store.writable, 'writes open');
  await sleep(50);
  const state = rt.s.sessions[se.id].state;
  assert.ok(!['think', 'gen', 'tool', 'stopping'].includes(state), `not left mid-turn with no turn: ${state}`);
  assert.ok(!rt.turns.has(se.id));
  await rt.store.flush();
});

test('a deleted agent’s queued message, with the Undo window ending while the store is closed, is posted exactly once after Retry (#597’s release, across an outage)', async () => {
  let release = () => {};
  rt.adapters.register({
    name: 'release-busy',
    async deliver(_se, _message, ctx) {
      await new Promise((r) => {
        release = () => r(undefined);
        ctx.signal.addEventListener('abort', () => r(undefined), { once: true });
      });
    },
  });
  const p = rt.createPersona({ handle: 'relbusy', backend: 'release-busy' });
  const other = rt.createPersona({ handle: 'relother' }); // the conversation outlives the deleted agent
  const t = rt.createThread({ projectId: 'p1', title: 'Release', personaIds: [p.id, other.id] });
  const se = rt.sessionsIn(t.id).find((x) => x.personaId === p.id);
  await rt.store.flush();
  rt.sendMessage(t.id, { text: '@relbusy a long job' });
  await until(() => rt.turns.has(se.id), 'the busy turn');
  assert.ok(rt.sendMessage(t.id, { text: '@relbusy later, please' }).queued, 'queued behind the busy turn');
  rt.deleteSession(se.id);
  release();
  await until(() => !rt.turns.has(se.id) && !rt.exiting.has(se.id), 'the turn to end');
  rt.updateSession(se.id, { deleting: Date.now() - 1 }); // the Undo window is over: what a re-arm reads
  await rt.store.flush();
  rt.store.fail(eio());
  rt.purgeSession(se.id); // the window ends while closed: the purge, and its release, wait
  const posted = () => rt.store.items(t.id).filter((i) => i.kind === 'user' && i.text === '@relbusy later, please').length;
  assert.equal(posted(), 0, 'nothing posted while closed');
  await rt.store.reload(); // the owned deferral is dropped; the re-armed del: purges
  await until(() => !rt.s.sessions[se.id], 'the purge after Retry');
  await sleep(100);
  assert.equal(posted(), 1, 'posted once, not twice and not lost');
  assert.deepEqual(rt.s.threads[t.id].queue ?? [], []);
  await rt.store.flush();
});
