// ST-3 (#508’s requirements, “Storage”; design 6.6, decision 7): when the store can’t be written, Postbox refuses
// writes and starts no turn, the page still reads, and a turn running when Redis went away stops, saying why. Nothing
// it couldn’t save ends Postbox: an adapter’s stream listener that saves the backend’s session id while Redis is down
// used to throw out of the listener, which ends the process. A real Postbox (start({ listen: false })) on a data
// folder whose Redis child the test kills, with a scripted agent.

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

/**
 * A scripted agent: its turn says it’s working, then waits until it’s stopped. Its stream is an EventEmitter, as a
 * real adapter’s readline is, so what it does in a listener runs outside any promise.
 */
function scripted() {
  const a = {
    name: 'mock',
    /** @type {{ message: any, ctx: any }[]} */
    calls: [],
    stream: new EventEmitter(),
    /** @param {any} _se @param {any} message @param {any} ctx */
    async deliver(_se, message, ctx) {
      a.calls.push({ message, ctx });
      a.stream.removeAllListeners();
      // A line of the backend’s stream: its session id, then text, as the Claude Code adapter’s readStream does.
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

test('ST-3: a turn running when Redis dies stops with the store named, nothing ends Postbox, and nothing starts until writes reopen', async () => {
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

  // Redis dies under the running turn.
  /** @type {any} */ (store).redis.sup.child.kill('SIGKILL');
  await until(() => !store.writable, 'writes to close');
  // The backend’s stream goes on: a line comes after Redis went away, in a listener, as readline delivers it.
  assert.doesNotThrow(() => agent.stream.emit('line', 'cs_after_outage'), 'a save from a stream listener doesn’t throw out of it');
  await until(() => !rt.turns.has(se.id), 'the running turn to stop');
  assert.equal(turn.abort.signal.aborted, true, 'the agent was told to stop');
  assert.match(String(turn.abort.signal.reason?.message), /save changes/, 'the stop names the store');

  // No turn starts while writes are closed: a wake for the agent waits, and a message of yours is refused, naming why.
  rt.deliver(se.id, { kind: 'agent', from: '@someone', text: 'Are you there?' });
  assert.equal(agent.calls.length, 1, 'no turn started while the store is down');
  const refused = await call({ method: 'POST', path: `/api/threads/${t.id}/messages`, cookie, body: { text: 'Hello?' } });
  assert.equal(refused.status, 503, 'a write is refused with 503, not a server error');
  assert.equal(refused.json.code, 'ESTOREDOWN');
  assert.match(refused.json.error, /can’t save changes/);
  assert.ok(refused.json.cause, 'the refusal names the cause');
  // The page still reads, and the status says why.
  const read = await call({ path: '/api/state' });
  assert.equal(read.status, 200);
  assert.equal(read.json.store.state, 'down');
  assert.ok(read.json.store.cause);

  // The child comes back (Postbox restarts it), reads Redis back, and writes reopen.
  await until(() => store.writable, 'writes to reopen');
  await until(() => agent.calls.length === 2, 'the waiting wake to start its turn');
  assert.equal(agent.calls[1].message.text, 'Are you there?');
  const stopped = store.items(t.id).find((it) => it.turnId === turn.id && it.kind === 'agent');
  assert.equal(stopped?.status, 'stopped', 'the stopped turn’s reply is marked stopped');
  assert.equal(stopped?.stopReason, 'store', 'and says the store stopped it');
  assert.equal(store.state.sessions[se.id].backendState?.claudeSessionId, 'cs_after_outage', 'the session id it couldn’t save then is saved now');
  rt.stop(se.id, { silent: true });
  await store.flush();
});

test('ST-3: while Redis can’t start, a write is refused with 503 and its cause, the page reads, and Retry brings it back', async () => {
  const { store } = app;
  await store.flush();
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  const sup = /** @type {any} */ (store).redis.sup;
  const home = sup.home;
  // Its Redis dies, and can’t start again: its build is gone.
  sup.home = join(dir, 'no-redis-here');
  sup.child.kill('SIGKILL');
  await until(() => store.status.state === 'down' && /** @type {any} */ (store.status).cause === 'binary-missing', 'the cause to be the missing build');
  const refused = await call({ method: 'PUT', path: '/api/settings', cookie, body: { theme: 'light' } });
  assert.equal(refused.status, 503, 'refused, not a server error');
  assert.deepEqual([refused.json.code, refused.json.cause], ['ESTOREDOWN', 'binary-missing']);
  assert.match(refused.json.error, /isn’t where Postbox keeps it/, 'the refusal says what happened');
  assert.notEqual(store.state.settings.theme, 'light', 'and nothing changed');
  const read = await call({ path: '/api/state' });
  assert.equal(read.status, 200, 'the page still reads');
  assert.equal(read.json.store.cause, 'binary-missing');
  // Retry needs the page’s token, as every write does; with the build back, it starts Redis and writes reopen.
  assert.equal((await call({ method: 'POST', path: '/api/store/retry' })).status, 403);
  sup.home = home;
  const retried = await call({ method: 'POST', path: '/api/store/retry', cookie });
  assert.equal(retried.status, 200);
  await until(() => store.writable, 'writes to reopen after Retry');
  assert.equal((await call({ method: 'PUT', path: '/api/settings', cookie, body: { theme: 'light' } })).status, 200);
});
