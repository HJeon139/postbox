// A conversation’s items by range, and its search (#1155): what the page loads instead of every item of every
// conversation. Each answer carries the seq it’s as of, and only a conversation that’s here answers.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { threadSearch } from '../server/thread-search.mjs';
import { apply, emptyState } from '../shared/state.mjs';
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
  // More than MOST (500), so the cap on a range's length shows.
  for (let i = 0; i < 600; i++)
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
  assert.deepEqual([latest.json.start, latest.json.total, latest.json.seq], [500, 600, app.store.state.seq]);
  assert.equal(ids(latest).at(-1), 'i599');
  const before = await get('/api/threads/room/items?before=i150&limit=20');
  assert.deepEqual([before.json.start, ids(before)[0], ids(before).at(-1)], [130, 'i130', 'i149']);
  const afterIt = await get('/api/threads/room/items?after=i590&limit=20');
  assert.deepEqual(ids(afterIt), ['i591', 'i592', 'i593', 'i594', 'i595', 'i596', 'i597', 'i598', 'i599']);
  const around = await get('/api/threads/room/items?around=i3&limit=10');
  assert.deepEqual([around.json.start, ids(around).length], [0, 10], 'around the start: as many as asked, from the first');
  const fraction = await get('/api/threads/room/items?before=i300&limit=10.6');
  assert.deepEqual([fraction.json.start, ids(fraction).length], [290, 10], 'a fractional limit is floored');
  const first = await get('/api/threads/room/items?first&limit=20');
  assert.deepEqual([first.json.start, ids(first)[0], ids(first).at(-1)], [0, 'i0', 'i19'], 'the first, for Home');
  const whole = await get('/api/threads/room/items?limit=all');
  assert.deepEqual([whole.json.start, whole.json.items.length], [0, 600], 'all of them, for a page with the window off');
  const capped = await get('/api/threads/room/items?limit=100000');
  assert.equal(capped.json.items.length, 500, 'a limit is capped at MOST');
  assert.deepEqual([capped.json.start, ids(capped).at(-1)], [100, 'i599'], 'the latest 500');
});

test('an item or a conversation that isn’t here is a 404 that says so', async () => {
  assert.equal((await get('/api/threads/room/items?around=nope')).status, 404);
  assert.equal((await get('/api/threads/nowhere/items')).status, 404);
  assert.equal((await get('/api/threads/__proto__/items')).status, 404);
  assert.equal((await get('/api/threads/%E0/items')).status, 404, 'an id that isn’t valid percent-encoding');
});

test('search finds items the page hasn’t loaded, with their words, and follows a new one', async () => {
  const r = await get(`/api/threads/room/search?q=${encodeURIComponent('walrus')}`);
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.json.hits.map((/** @type {any} */ h) => [h.id, h.kind, h.text]),
    [['i7', 'user', 'the walrus plan']],
  );
  const own = threadSearch(app.store);
  own.search('room', 'walrus', 5);
  const writes = own.indexOf('room')?.writes ?? 0;
  app.store.emit('item.add', { threadId: 'room', item: { id: 'late', kind: 'user', text: 'another walrus', at: 300 } });
  assert.equal((own.indexOf('room')?.writes ?? 0) - writes, 1, 'one entry written for one new item, not the room’s');
  const again = await get('/api/threads/room/search?q=walrus');
  assert.deepEqual(again.json.hits.map((/** @type {any} */ h) => h.id).sort(), ['i7', 'late']);
});

/** A store whose events and reloads the test sends by hand, for the search index alone. */
function fakeStore() {
  const state = emptyState();
  apply(state, 'thread', { id: 't', kind: 'room' });
  apply(state, 'item.add', { threadId: 't', item: { id: 'a', kind: 'user', text: 'the walrus plan' } });
  /** @type {(ev: any) => void} */
  let heard = () => {};
  /** @type {() => void} */
  let reloaded = () => {};
  const store = { state, subscribe: (/** @type {any} */ f) => (heard = f), onReload: (/** @type {any} */ f) => (reloaded = f) };
  const emit = (/** @type {string} */ type, /** @type {any} */ data) => {
    apply(store.state, type, data);
    heard({ type, data });
  };
  return { store, emit, reload: () => reloaded() };
}
const found = (/** @type {any} */ search, /** @type {string} */ q) => search.search('t', q, 5).map((/** @type {any} */ h) => h.id);

test('a patch rewrites the item’s entry: its new words are found, its old ones aren’t', () => {
  const { store, emit } = fakeStore();
  const search = threadSearch(store);
  assert.deepEqual(found(search, 'walrus'), ['a']);
  emit('item.patch', { threadId: 't', id: 'a', patch: { text: 'the otter plan' } });
  assert.deepEqual(found(search, 'otter'), ['a']);
  assert.deepEqual(found(search, 'walrus'), []);
});

test('a removed conversation’s index goes with it, so one of the same id is indexed afresh', () => {
  const { store, emit } = fakeStore();
  const search = threadSearch(store);
  assert.deepEqual(found(search, 'walrus'), ['a']);
  emit('remove', { kind: 'thread', id: 't' });
  store.state.threads.t = { id: 't', kind: 'room' };
  store.state.items.t = [{ id: 'b', kind: 'user', text: 'a walrus again' }];
  assert.deepEqual(found(search, 'walrus'), ['b']);
});

test('a reload, which replaces the state, drops every index', () => {
  const { store, reload } = fakeStore();
  const search = threadSearch(store);
  assert.deepEqual(found(search, 'walrus'), ['a']);
  const next = emptyState();
  apply(next, 'thread', { id: 't', kind: 'room' });
  apply(next, 'item.add', { threadId: 't', item: { id: 'c', kind: 'user', text: 'a walrus restored' } });
  store.state = next;
  reload();
  assert.deepEqual(found(search, 'walrus'), ['c']);
});
