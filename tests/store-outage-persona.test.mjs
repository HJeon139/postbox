// The persona purge, held in an adapter’s forget across an outage or a Retry (the 1b invariants, I1; gpt’s and critic’s
// findings on 1b: a fence after a loop, not after each await). Split from store-outage-timers.test.mjs under the
// file-length rule; the same real Postbox setup on its own folder and port.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { deletePersona, purgePersona } from '../server/persona-delete.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
};

const PORT = 4444;
const eio = () => Object.assign(new Error('disk sync refused'), { code: 'EIO' });
let app;
let dir;
let rt;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-outage-persona-'));
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
  rt = app.rt;
  rt.store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  await rt.store.flush();
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

// A spec that fails may leave writes closed: the next one starts open, so each fails for its own reason.
beforeEach(async () => {
  if (!rt.store.writable) await rt.store.reload();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits for a condition, up to 5 s. @param {() => boolean} pred @param {string} what */
const until = async (pred, what) => {
  for (let i = 0; i < 200 && !pred(); i++) await sleep(25);
  assert.ok(pred(), `waited for ${what}`);
};
/** A room with one agent, durable. */
async function room(handle) {
  const p = rt.createPersona({ handle });
  const t = rt.createThread({ projectId: 'p1', title: `T ${handle}`, personaIds: [p.id] });
  const [se] = rt.sessionsIn(t.id);
  await rt.store.flush();
  return { p, t, se };
}

test('a persona purge held in one adapter’s forget across an outage starts no further forget while closed, and finishes after Retry', async () => {
  const persona = await room('ptwo');
  const first = deferred();
  let secondWhileClosed = false;
  let seconds = 0;
  rt.adapters.register({ name: 'memory-a', forget: () => first.promise, async deliver() {} });
  rt.adapters.register({
    name: 'memory-b',
    forget: async () => {
      seconds++;
      if (!rt.store.writable) secondWhileClosed = true;
    },
    async deliver() {},
  });
  deletePersona(rt, persona.p.id);
  rt.store.emit('persona', { ...rt.s.personas[persona.p.id], deleting: Date.now() - 1 });
  await rt.store.flush();
  const purge = purgePersona(rt, persona.p.id);
  await sleep(10);
  rt.store.fail(eio());
  first.resolve(); // the first forget answers into a closed store
  await purge;
  await sleep(10);
  assert.equal(secondWhileClosed, false, 'the second adapter’s forget did not run while the store was closed');
  assert.ok(rt.s.personas[persona.p.id], 'not removed while closed');
  await rt.store.reload();
  await until(() => !rt.s.personas[persona.p.id], 'the purge to finish after Retry');
  assert.ok(seconds >= 1, 'the second forget ran once writes were open');
  await rt.store.flush();
});

test('a persona purge held in one adapter’s forget across a Retry stops its old continuation and finishes against the new history', async () => {
  const persona = await room('pretry');
  const first = deferred();
  const seconds = [];
  let removes = 0;
  const off = rt.store.subscribe((ev) => {
    if (ev.type === 'remove' && ev.data?.kind === 'persona' && ev.data.id === persona.p.id) removes++;
  });
  rt.adapters.register({ name: 'memory-c', forget: () => first.promise, async deliver() {} });
  rt.adapters.register({
    name: 'memory-d',
    forget: async () => {
      seconds.push(rt.store.epoch);
    },
    async deliver() {},
  });
  deletePersona(rt, persona.p.id);
  rt.store.emit('persona', { ...rt.s.personas[persona.p.id], deleting: Date.now() - 1 });
  await rt.store.flush();
  const purge = purgePersona(rt, persona.p.id);
  await sleep(10);
  const old = rt.store.epoch;
  rt.store.fail(eio());
  await rt.store.reload(); // Retry runs to the end while the first forget is still held
  assert.notEqual(rt.store.epoch, old);
  first.resolve();
  await purge;
  await until(() => !rt.s.personas[persona.p.id], 'the purge to finish');
  assert.deepEqual(seconds, [rt.store.epoch], 'the second forget ran once, under the new history, not from the old continuation');
  assert.equal(removes, 1);
  off();
  await rt.store.flush();
});

test('a persona purge deferred during an outage, with an async forget, runs once after Retry and never twice at once (the integrator’s double-purge)', async () => {
  const persona = await room('pasync');
  let inflight = 0;
  let maxInflight = 0;
  let forgets = 0;
  rt.adapters.register({
    name: 'memory-async',
    forget: async () => {
      forgets++;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await sleep(30); // a real adapter’s rm takes a while
      inflight--;
    },
    async deliver() {},
  });
  let removes = 0;
  const off = rt.store.subscribe((ev) => {
    if (ev.type === 'remove' && ev.data?.kind === 'persona' && ev.data.id === persona.p.id) removes++;
  });
  deletePersona(rt, persona.p.id);
  rt.store.emit('persona', { ...rt.s.personas[persona.p.id], deleting: Date.now() - 1 });
  await rt.store.flush();
  rt.store.fail(eio());
  await purgePersona(rt, persona.p.id); // the window ends while closed: the purge defers
  await rt.store.reload(); // the reload also re-arms delp: at 0 ms
  await until(() => !rt.s.personas[persona.p.id], 'the purge after Retry');
  await sleep(100);
  assert.deepEqual({ forgets, removes, maxInflight }, { forgets: 1, removes: 1, maxInflight: 1 }, 'one purge, not two at once');
  off();
  await rt.store.flush();
});
