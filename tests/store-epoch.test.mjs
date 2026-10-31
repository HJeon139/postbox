// The store’s history epoch (server/store.mjs, Store.epoch; #508’s PR 1a): a random token new at every load(), the
// history a seq counts within. /api/state gives the page both, and the page echoes the epoch when its stream connects
// (?epoch=, or an X-Postbox-Epoch header for a tool) beside its seq. A seq alone can’t tell a tab merely behind from one
// on a lost timeline: after a restart, startup emits before any tab is back, so the seq passes the id of a tab that
// saw events the restarted store never kept, and it would get the backlog after its own id and keep what the store
// lost. A stream that names another epoch, or a seq past the store’s, is told to resync, whatever its seq. Event ids
// stay the plain seq, so tools reading the stream (tools/uat/history.mjs) are unchanged; the stream names its epoch in
// its first frame, which they ignore.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { Store } from '../server/store.mjs';
import { fakeRequest } from './fake-http.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4457;
const tmp = () => mkdtemp(join(tmpdir(), 'pb-epoch-'));
let app;
let dir;
before(async () => {
  dir = await tmp();
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  for (let i = 0; i < 3; i++) app.store.emit('thread', { id: `t${i}`, members: [] });
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * A stream connection through the router, as a page or a tool opens one: the frames it was sent, as `event` or
 * `id:event`, keep-alives and the retry line aside; and the epochs its epoch frames named.
 * @param {string} query @param {Record<string, string>} [headers]
 */
async function stream(query, headers = {}) {
  const req = /** @type {any} */ (Readable.from([]));
  Object.assign(req, { method: 'GET', url: `/api/stream${query}`, headers: { host: `127.0.0.1:${PORT}`, ...headers }, socket: { remoteAddress: '127.0.0.1' } });
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
  await app.handle(req, res);
  req.emit('close');
  const frames = written
    .join('')
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':') && !f.startsWith('retry'));
  const name = (f) => {
    const id = /^id: (\d+)/m.exec(f)?.[1];
    const ev = /^event: (\S+)/m.exec(f)?.[1];
    return id ? `${id}:${ev}` : ev;
  };
  return {
    frames: frames.filter((f) => !f.startsWith('event: epoch') && !f.startsWith('event: status')).map(name), // the status is 1b’s first frame
    epochs: frames.filter((f) => f.startsWith('event: epoch')).map((f) => JSON.parse(f.split('data: ')[1])),
    first: name(frames[0] ?? ''),
  };
}

test('a store has an epoch, a token new at each load(), so a reload of the same folder runs on another', async () => {
  const d = await tmp();
  const a = await new Store(d).load();
  assert.ok(typeof a.epoch === 'string' && a.epoch.length >= 8, `a random token: ${a.epoch}`);
  await a.close();
  const b = await new Store(d).load();
  assert.ok(typeof b.epoch === 'string' && b.epoch.length >= 8, `a random token: ${b.epoch}`);
  assert.notEqual(b.epoch, a.epoch, 'a reload is a new history, even of the same log');
  await b.close();
  const m = new Store(null);
  assert.ok(typeof m.epoch === 'string' && m.epoch.length >= 8, `an in-memory store has one too: ${m.epoch}`);
  await rm(d, { recursive: true });
});

test('/api/state gives the page the store’s epoch beside its seq', async () => {
  const r = await fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, path: '/api/state' });
  assert.equal(r.status, 200);
  assert.equal(r.json.seq, app.store.state.seq);
  assert.equal(r.json.epoch, app.store.epoch);
  assert.ok(typeof r.json.epoch === 'string' && r.json.epoch.length >= 8, `a token the page can echo: ${r.json.epoch}`);
});

test('a stream naming another epoch is told to resync whatever its seq; one on the store’s epoch gets the gap after its seq', async () => {
  const seq = app.store.state.seq;
  const stale = await stream(`?since=${seq}&epoch=${encodeURIComponent('ep_elsewhere')}`);
  assert.deepEqual(stale.frames, ['resync'], 'at the store’s seq, but on a lost timeline');
  const behind = await stream(`?since=${seq - 2}&epoch=${encodeURIComponent(app.store.epoch)}`);
  assert.deepEqual(behind.frames, [`${seq - 1}:thread`, `${seq}:thread`], 'merely behind: the gap, no resync');
  assert.deepEqual(behind.epochs, [app.store.epoch], 'the stream names its epoch once');
  assert.equal(behind.first, 'epoch', 'in its first frame, before the backlog');
  const current = await stream(`?since=${seq}&epoch=${encodeURIComponent(app.store.epoch)}`);
  assert.deepEqual(current.frames, [], 'at the store’s seq on its epoch: nothing to send');
});

test('a tool names its epoch in an X-Postbox-Epoch header; one that names none is served by its seq alone', async () => {
  const seq = app.store.state.seq;
  const stale = await stream('', { 'last-event-id': String(seq), 'x-postbox-epoch': 'ep_elsewhere' });
  assert.deepEqual(stale.frames, ['resync']);
  const unnamed = await stream('', { 'last-event-id': String(seq - 1) }); // tools/uat/history.mjs, and a page from before the epoch
  assert.deepEqual(unnamed.frames, [`${seq}:thread`], 'no epoch named: by its seq, as before');
});

test('a stream whose seq is past the store’s (a restart dropped what it saw) is told to resync, not left to drop every later event', async () => {
  const ahead = await stream(`?since=${app.store.state.seq + 5}`);
  assert.deepEqual(ahead.frames, ['resync']);
});
