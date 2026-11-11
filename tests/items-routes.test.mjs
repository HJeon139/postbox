// A conversation’s items by range, and its search (#1155): what the page loads instead of every item of every
// conversation. Each answer carries the seq it’s as of, and only a conversation that’s here answers.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fakeRequest } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4497;
let app;
before(async () => {
  const dir = await tempDir('pb-items-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  app.store.emit('thread', { id: 'room', members: [] });
  for (let i = 0; i < 250; i++)
    app.store.emit('item.add', { threadId: 'room', item: { id: `i${i}`, kind: 'user', text: i === 7 ? 'the walrus plan' : `message ${i}`, at: i } });
});
after(async () => {
  await app.close();
});

const get = (/** @type {string} */ path) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, path });
const ids = (/** @type {any} */ r) => r.json.items.map((/** @type {any} */ it) => it.id);

test('with no anchor, the latest page; with before, after or around an item, the range there', async () => {
  const latest = await get('/api/threads/room/items');
  assert.equal(latest.status, 200);
  assert.equal(latest.json.items.length, 100);
  assert.deepEqual([latest.json.start, latest.json.total, latest.json.seq], [150, 250, app.store.state.seq]);
  assert.equal(ids(latest).at(-1), 'i249');
  const before = await get('/api/threads/room/items?before=i150&limit=20');
  assert.deepEqual([before.json.start, ids(before)[0], ids(before).at(-1)], [130, 'i130', 'i149']);
  const afterIt = await get('/api/threads/room/items?after=i240&limit=20');
  assert.deepEqual(ids(afterIt), ['i241', 'i242', 'i243', 'i244', 'i245', 'i246', 'i247', 'i248', 'i249']);
  const around = await get('/api/threads/room/items?around=i3&limit=10');
  assert.deepEqual([around.json.start, ids(around).length], [0, 10], 'around the start: as many as asked, from the first');
  const capped = await get('/api/threads/room/items?limit=100000');
  assert.equal(capped.json.items.length, 250, 'a limit is capped');
});

test('an item or a conversation that isn’t here is a 404 that says so', async () => {
  assert.equal((await get('/api/threads/room/items?around=nope')).status, 404);
  assert.equal((await get('/api/threads/nowhere/items')).status, 404);
  assert.equal((await get('/api/threads/__proto__/items')).status, 404);
});

test('search finds items the page hasn’t loaded, with their words, and follows a new one', async () => {
  const r = await get(`/api/threads/room/search?q=${encodeURIComponent('walrus')}`);
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.json.hits.map((/** @type {any} */ h) => [h.id, h.kind, h.text]),
    [['i7', 'user', 'the walrus plan']],
  );
  app.store.emit('item.add', { threadId: 'room', item: { id: 'late', kind: 'user', text: 'another walrus', at: 300 } });
  const again = await get('/api/threads/room/search?q=walrus');
  assert.deepEqual(again.json.hits.map((/** @type {any} */ h) => h.id).sort(), ['i7', 'late']);
});
