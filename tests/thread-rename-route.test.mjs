// PATCH /api/threads/:id renames a conversation, and does nothing else. Until #1623 it also set a room’s wake chain
// limit (#1035); the chain’s cap is now one loop guard on the server (POSTBOX_CHAIN_LIMIT), so a `chainLimit` in the
// body is ignored, and nothing on the server reads one a conversation stored before.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { sources } from './server-sources-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4471;
let app;
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
const pageCookie = async () => (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];

before(async () => {
  const dir = tempDir('pb-thread-rename-route-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  app.store.emit('project', { id: 'pr_rn', name: 'Rename', folder: dir });
});
after(() => app.close());

const room = () => app.rt.createThread({ projectId: 'pr_rn', title: 'Room' });
const threadOf = (id) => app.store.state.threads[id];

test('PATCH renames a conversation with the page’s token, and an empty name is refused', async () => {
  const cookie = await pageCookie();
  const t = room();
  const r = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { title: 'Renamed' }, cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(threadOf(t.id).title, 'Renamed');
  const empty = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { title: ' ' }, cookie });
  assert.equal(empty.status, 422);
  assert.equal(empty.json.error, 'A conversation needs a name.');
  assert.equal(threadOf(t.id).title, 'Renamed', 'the refused name changed nothing');
});

test('#1623 a chainLimit in the PATCH is ignored: the name changes, and no limit is stored', async () => {
  const cookie = await pageCookie();
  const t = room();
  const r = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { title: 'Renamed', chainLimit: 5 }, cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(threadOf(t.id).title, 'Renamed');
  assert.equal(Object.hasOwn(threadOf(t.id), 'chainLimit'), false);
});

test('PATCH /api/threads/:id needs the page’s token: without it, it’s refused and the name is unchanged', async () => {
  const t = room();
  const r = await call({ method: 'PATCH', path: `/api/threads/${t.id}`, body: { title: 'Renamed' } });
  assert.equal(r.status, 403, r.text);
  assert.equal(threadOf(t.id).title, 'Room');
});

test('#1623 nothing in server/ reads a conversation’s chainLimit, so one stored before is ignored', () => {
  const naming = sources()
    .filter(([, text]) => /\bchainLimit\b/.test(text))
    .map(([path]) => path);
  assert.deepEqual(naming, []);
});
