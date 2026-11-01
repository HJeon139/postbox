// Turns while the store is closed (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants, I1 and I3;
// server/store-outage.mjs): a turn running when a write fails stops with the store named, a save from a stream listener
// doesn’t throw out of it, no turn starts while writes are closed, a message of yours is refused with the cause, the page
// still reads, and Retry brings the stopped turn’s records, the saved session id and the waiting wake back, in order.
// A real Postbox (start({ listen: false })) on a data folder, a scripted agent, and the store’s own fail().

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4441;
const eio = () => Object.assign(new Error('disk sync refused'), { code: 'EIO' });
let app;
let dir;
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-outage-'));
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

/** Waits for a condition, up to 10 s. @param {() => boolean} pred @param {string} what */
const until = async (pred, what) => {
  for (let i = 0; i < 400 && !pred(); i++) await new Promise((ok) => setTimeout(ok, 25));
  assert.ok(pred(), `waited for ${what}`);
};

/** A scripted agent: its turn says it’s working, then waits until it’s stopped. Its stream is an EventEmitter, as a real adapter’s readline is. */
function scripted() {
  const a = {
    name: 'mock',
    /** @type {{ message: any, ctx: any }[]} */
    calls: [],
    stream: new EventEmitter(),
    async deliver(_se, message, ctx) {
      a.calls.push({ message, ctx });
      a.stream.removeAllListeners();
      a.stream.on('line', (id) => {
        ctx.saveState({ claudeSessionId: id });
        ctx.text(' and more');
      });
      ctx.text('Working');
      await new Promise((ok) => ctx.signal.addEventListener('abort', ok, { once: true }));
    },
  };
  return a;
}

test('ST-3: a turn running when a write fails stops with the store named, nothing starts until Retry, then what waited runs in order', async () => {
  const { rt, store } = app;
  const agent = scripted();
  rt.adapters.register(agent);
  const projectId = 'pr_outage';
  store.emit('project', { id: projectId, name: 'Outage', folder: dir });
  const p = rt.createPersona({ handle: 'builder', backend: 'mock' });
  const t = rt.createThread({ projectId, title: 'Outage', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.sendMessage(t.id, { text: 'Build it' });
  await until(() => agent.calls.length === 1 && rt.turns.has(se.id), 'the turn to start');
  const turn = rt.turns.get(se.id);
  await store.flush();
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];

  // A write fails under the running turn.
  store.fail(eio());
  assert.equal(store.writable, false);
  // The backend’s stream goes on: a line comes after the failure, in a listener, as readline delivers it.
  assert.doesNotThrow(() => agent.stream.emit('line', 'cs_after_outage'), 'a save from a stream listener doesn’t throw out of it');
  await until(() => !rt.turns.has(se.id), 'the running turn to stop');
  assert.equal(turn.abort.signal.aborted, true, 'the agent was told to stop');
  assert.match(String(turn.abort.signal.reason?.message), /save changes/, 'the stop names the store');

  // No turn starts while writes are closed: a wake for the agent waits, and a message of yours is refused, naming why.
  rt.deliver(se.id, { kind: 'agent', from: '@someone', text: 'Are you there?' });
  assert.equal(agent.calls.length, 1, 'no turn started while the store is closed');
  const refused = await call({ method: 'POST', path: `/api/threads/${t.id}/messages`, cookie, body: { text: 'Hello?' } });
  assert.equal(refused.status, 503, 'a write is refused with 503, not a server error');
  assert.equal(refused.json.code, 'store-closed');
  assert.match(refused.json.error, /can’t write its event log.*EIO/);
  const read = await call({ path: '/api/state' });
  assert.equal(read.status, 200, 'the page still reads');
  assert.equal(read.json.store.writable, false);
  assert.equal(read.json.store.cause.code, 'EIO');

  // Retry reopens; what waited runs after the install, in order: the session id first, the stop’s records, then the wake.
  const retried = await call({ method: 'POST', path: '/api/store/retry', cookie });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  await until(() => store.writable, 'writes to reopen');
  await until(() => agent.calls.length === 2, 'the waiting wake to start its turn');
  assert.equal(agent.calls[1].message.text, 'Are you there?');
  const stopped = store.items(t.id).find((it) => it.turnId === turn.id && it.kind === 'agent');
  assert.equal(stopped?.status, 'stopped', 'the stopped turn’s reply is marked stopped');
  assert.equal(stopped?.stopReason, 'store', 'and says the store stopped it');
  assert.equal(store.state.sessions[se.id].backendState?.claudeSessionId, 'cs_after_outage', 'the session id it couldn’t save then is saved now');
  rt.stop(se.id, { silent: true });
  await store.flush();
  const b = await call({ path: '/api/state' });
  assert.equal(b.json.store.writable, true);
});

test('T-32: a scheduled wake armed before the failure runs only after Retry has installed the recovered state', async () => {
  const { rt, store } = app;
  const agent = rt.adapters.get('mock');
  const before = agent.calls.length;
  const p = rt.createPersona({ handle: 'waker', backend: 'mock' });
  const t = rt.createThread({ projectId: 'pr_outage', title: 'Wake', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  await store.flush();
  const sc = rt.schedule(se.id, { inMs: 1000, note: 'later' });
  assert.ok(sc.id);
  // Armed before the failure means on disk before it: an unsynced schedule is not in the recovered state, and only the
  // stale held start used to deliver it (the integrator’s re-review of #598).
  await store.flush();
  store.fail(eio());
  // The timer fires while the store is closed: the wake’s turn waits, it does not start.
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(agent.calls.length, before, 'no turn started from the old timer while closed');
  assert.equal(rt.turns.has(se.id), false);
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  assert.equal((await call({ method: 'POST', path: '/api/store/retry', cookie })).status, 200);
  await until(() => agent.calls.length === before + 1 && rt.turns.has(se.id), 'the wake’s turn to start after the install');
  assert.ok(store.writable, 'and only once writes were open again');
  rt.stop(se.id, { silent: true });
  await until(() => !rt.turns.has(se.id) && !rt.exiting.has(se.id), 'the turn to stop and anything held behind it to end');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(agent.calls.length, before + 1, 'one delivery for one wake: nothing followed it');
  await store.flush();
});

test('a scheduled wake’s turn stopped by the outage has one owner after Retry: the re-arm runs it again as interrupted, once (the integrator’s re-review)', async () => {
  const { rt, store } = app;
  const agent = rt.adapters.get('mock');
  const p = rt.createPersona({ handle: 'sleeper', backend: 'mock' });
  const t = rt.createThread({ projectId: 'pr_outage', title: 'Sleep', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  await store.flush();
  const sc = rt.schedule(se.id, { inMs: 1000, note: 'now' });
  await until(() => rt.turns.has(se.id), 'the wake’s turn to start');
  assert.equal(rt.s.schedules[sc.id]?.running, true);
  await store.flush();
  const before = agent.calls.length;
  store.fail(eio());
  await until(() => !rt.turns.has(se.id), 'the turn to stop');
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  assert.equal((await call({ method: 'POST', path: '/api/store/retry', cookie })).status, 200);
  // The stop’s record doesn’t settle the wake as well (two owners would cancel it): the re-arm finds it running on
  // disk, marks it interrupted and runs it again, as a restart does and as the agent was told.
  await until(() => agent.calls.length === before + 1 && rt.turns.has(se.id), 'the wake to run again after Retry');
  assert.equal(agent.calls.at(-1).message.scheduledWakeId, sc.id, 'the same wake, re-armed (an interrupted note is added only when its tools had started)');
  const stopped = store.items(t.id).find((it) => it.kind === 'agent' && it.sessionId === se.id && it.stopReason === 'store');
  assert.ok(stopped, 'the first reply says the store stopped it');
  rt.stop(se.id, { silent: true }); // your Stop ends it for good
  await until(() => !rt.turns.has(se.id) && !rt.exiting.has(se.id), 'the second turn to end');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(agent.calls.length, before + 1, 'it ran again once, not twice');
  assert.equal(rt.timers.has(sc.id), false, 'no timer left after your Stop');
  agent.calls.length = 0;
  await store.flush();
});

/** Makes the store’s segment handles wait on a gate for their fsync once hold() is called, until release(). */
function heldSync(store) {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let holding = false;
  const realOpen = store.io.open;
  store.io = {
    ...store.io,
    open: async (path, flags, mode) => {
      const fh = await realOpen.call(store.io, path, flags, mode);
      if (!String(path).includes('events-')) return fh;
      return new Proxy(fh, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              if (holding) await gate;
              return target.sync();
            };
          const v = Reflect.get(target, key, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
  return {
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      release();
    },
  };
}

test('while Retry reconciles, the router, the tools’ gate and a turn start stay closed; they open once the reconciling commit has landed', async () => {
  const { rt, store } = app;
  const agent = rt.adapters.get('mock');
  const before = agent.calls.length;
  const p = rt.createPersona({ handle: 'waiter', backend: 'mock' });
  const t = rt.createThread({ projectId: 'pr_outage', title: 'Reconcile', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  await store.flush();
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  store.fail(eio());
  // The reload listener reconciles through the one internal path, and its fsync is held (heldSync).
  const held = heldSync(store);
  let reconciled;
  const off = store.onReload(() => {
    held.hold(); // after the barrier: only the reconciling commit’s sync waits
    reconciled = store.reconcile([{ type: 'thread', data: { id: 'reconciled', members: [] } }], { opId: 'reconcile' });
    return reconciled;
  });
  const retried = call({ method: 'POST', path: '/api/store/retry', cookie });
  await until(() => !!reconciled, 'the listener to run after the install');
  // Closed throughout: the router, the tools and a turn start.
  const refused = await call({ method: 'POST', path: `/api/threads/${t.id}/messages`, cookie, body: { text: 'Hello?' } });
  assert.equal(refused.status, 503, 'a router write is refused while reconciling');
  assert.equal(store.writable, false, 'the tools’ gate reads the same flag');
  rt.deliver(se.id, { kind: 'agent', from: '@someone', text: 'Are you there?' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(agent.calls.length, before, 'no turn started while reconciling');
  held.release();
  assert.equal((await retried).status, 200);
  assert.ok(store.writable);
  assert.ok(store.state.threads.reconciled, 'the reconciling commit landed before anything opened');
  await until(() => agent.calls.length === before + 1, 'the waiting turn to start once writes opened');
  assert.equal((await call({ method: 'POST', path: `/api/threads/${t.id}/messages`, cookie, body: { text: 'Hello again' } })).status, 201);
  off();
  rt.stop(se.id, { silent: true });
  await until(() => !rt.turns.has(se.id), 'the turn to stop');
  await store.flush();
});
