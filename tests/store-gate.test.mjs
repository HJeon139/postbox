// What the server does while the store is closed (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants
// I1, I2, I3b): /api/state carries the store’s status; a write route is refused with 503 and the cause at the router,
// reads go on, Retry and Stop are allowed; POST /api/store/retry runs Retry and reopens; the live streams get a `status`
// frame when writes close or reopen, and `epoch` then `resync` when Retry installs a new epoch.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4459;
const eio = () => Object.assign(new Error('disk sync refused'), { code: 'EIO' });
let app;
let dir;
let cookie;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-gate-'));
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  app.store.emit('thread', { id: 't1', members: [] });
  await app.store.flush();
  cookie = (await fakeRequest(app.handle, { host: host(), path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const host = () => `127.0.0.1:${PORT}`;
const headers = () => ({ cookie, origin: app.origin, 'content-type': 'application/json' });

/** Opens a stream through the router and keeps its response, so frames sent later can be read. */
function openStream() {
  const req = /** @type {any} */ (Readable.from([]));
  Object.assign(req, { method: 'GET', url: '/api/stream', headers: { host: host() }, socket: { remoteAddress: '127.0.0.1' } });
  const written = [];
  const res = /** @type {any} */ ({
    headersSent: false,
    writeHead() {
      this.headersSent = true;
    },
    write: (s) => written.push(String(s)),
    end: (s) => s && written.push(String(s)),
    destroy() {},
  });
  const opened = app.handle(req, res);
  const frames = () =>
    written
      .join('')
      .split('\n\n')
      .filter((f) => f && !f.startsWith(':') && !f.startsWith('retry'))
      .map((f) => ({ event: /^event: (\S+)/m.exec(f)?.[1], data: /^data: (.*)$/m.exec(f)?.[1] }));
  return { opened, frames, close: () => req.emit('close') };
}

test('open: /api/state says the store is writable, with nothing lost and no warning', async () => {
  const r = await fakeRequest(app.handle, { host: host(), path: '/api/state' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.store, { writable: true, cause: null, lost: null, warning: null, retrying: false, savedThrough: app.store.state.seq });
});

test('closed: writes are refused with 503 and the cause; reads, Retry and Stop still answer; the stream hears the status', async () => {
  const s = openStream();
  await s.opened;
  app.store.fail(eio());
  const state = await fakeRequest(app.handle, { host: host(), path: '/api/state' });
  assert.equal(state.status, 200, 'reads go on');
  assert.equal(state.json.store.writable, false);
  assert.match(state.json.store.cause.message, /EIO/);
  const write = await fakeRequest(app.handle, { host: host(), method: 'PATCH', path: '/api/threads/t1', headers: headers(), body: { title: 'x' } });
  assert.equal(write.status, 503, 'a write is refused at the router');
  assert.match(write.json.error, /can’t write its event log.*EIO/);
  const stop = await fakeRequest(app.handle, { host: host(), method: 'POST', path: '/api/threads/t1/shell/none/stop', headers: headers(), body: {} });
  assert.notEqual(stop.status, 503, 'Stop is not refused by the gate (it may fail for its own reason)');
  const statuses = s.frames().filter((f) => f.event === 'status');
  assert.equal(statuses.length, 1, 'one status frame for the close');
  assert.equal(JSON.parse(statuses[0].data).writable, false);
  s.close();
});

test('POST /api/store/retry reopens the store on a new epoch; the stream hears status, epoch and resync', async () => {
  const s = openStream();
  await s.opened;
  const epoch = app.store.epoch;
  const r = await fakeRequest(app.handle, { host: host(), method: 'POST', path: '/api/store/retry', headers: headers(), body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.store.writable, true);
  assert.notEqual(app.store.epoch, epoch);
  const events = s.frames().map((f) => f.event);
  assert.deepEqual(events.slice(-4), ['status', 'epoch', 'resync', 'status'], events.join());
  const write = await fakeRequest(app.handle, { host: host(), method: 'PATCH', path: '/api/threads/t1', headers: headers(), body: { title: 'after' } });
  assert.equal(write.status, 200, `writes go on after Retry: ${write.text}`);
  s.close();
});
