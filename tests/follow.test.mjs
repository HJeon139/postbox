// Apps and asking blocks follow the conversation (#49, #92): an update the person has to see brings the one live
// copy to the newest point, and a one-line stub keeps its old place.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';

class Quiet {
  name = 'mock';
  async folderFor() {
    return null;
  }
  async deliver() {}
}

function setup() {
  const store = new Store(null);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(new Quiet()),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'alpha' });
  const b = rt.createPersona({ handle: 'beta' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id, b.id] });
  const [se, other] = rt.sessionsIn(t.id);
  return { store, rt, t, se, other, tools: rt.toolsFor(se.id) };
}
const kinds = (store, t) => store.items(t.id).map((i) => (i.kind === 'block' ? `${i.kind}:${i.block.id}` : i.kind === 'moved' ? `moved:${i.itemId}` : i.kind));
const say = (rt, t, se, text) => rt.addItem(t.id, { kind: 'agent', sessionId: se.id, handle: se.handle, text, status: 'done' });

test('#49: a new version brings the app to the newest point, with a stub where it was and one live copy', () => {
  const { store, rt, t, se, tools } = setup();
  tools.show_app({ id: 'pairs', title: 'Pair explorer', code: '<p>1</p>' });
  const item = store.items(t.id).at(-1);
  rt.appState('pairs', { tab: 'graph' });
  say(rt, t, se, 'Here it is.');
  rt.addItem(t.id, { kind: 'user', text: 'The graph overlaps.' });
  const r = tools.update_app({ id: 'pairs', code: '<p>2</p>', summary: 'each group laid out on its own' });
  assert.equal(r.ok, true);
  assert.match(r.message, /v2, shown at the newest point/);
  assert.deepEqual(kinds(store, t), ['moved:' + item.id, 'agent', 'user', 'block:pairs']);
  // The item itself moved: same id, so the app, answers and needs-you still name it, and there’s one copy.
  const moved = store.items(t.id).at(-1);
  assert.equal(moved.id, item.id);
  assert.equal(store.state.apps.pairs.itemId, item.id);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'block').length, 1);
  // Saved state and the versions carry over.
  assert.deepEqual(store.state.apps.pairs.state, { tab: 'graph' });
  assert.deepEqual(
    store.state.apps.pairs.versions.map((v) => v.summary),
    ['', 'each group laid out on its own'],
  );
  // The stub says what moved and leads to it.
  const stub = store.items(t.id)[0];
  assert.deepEqual({ what: stub.what, title: stub.title, v: stub.v, itemId: stub.itemId }, { what: 'app', title: 'Pair explorer', v: 2, itemId: item.id });
  // A third version moves it again; each earlier place keeps its one line.
  say(rt, t, se, 'Fixed.');
  tools.update_app({ id: 'pairs', code: '<p>3</p>', title: 'Pair explorer (fixed)' });
  assert.deepEqual(kinds(store, t), ['moved:' + item.id, 'agent', 'user', 'moved:' + item.id, 'agent', 'block:pairs']);
  assert.equal(store.items(t.id)[3].title, 'Pair explorer (fixed)');
});

test('#49: an app that’s already the newest item stays put, with no stub', () => {
  const { store, t, tools } = setup();
  tools.show_app({ id: 'ap', title: 'A', code: '<p>1</p>' });
  const r = tools.update_app({ id: 'ap', code: '<p>2</p>' });
  assert.equal(r.message, 'App ap is now v2.');
  assert.deepEqual(kinds(store, t), ['block:ap']);
});

test('#49: a session that last saw the app reads on from the stub, so nothing after it is skipped', () => {
  const { store, rt, t, other, tools } = setup();
  tools.show_app({ id: 'ap', title: 'A', code: '<p>1</p>' });
  const app = store.items(t.id).at(-1);
  rt.updateSession(other.id, { seenItem: app.id });
  rt.addItem(t.id, { kind: 'user', text: 'Make it blue.' });
  tools.update_app({ id: 'ap', code: '<p>2</p>' });
  const stub = store.items(t.id)[0];
  assert.equal(store.state.sessions[other.id].seenItem, stub.id);
  const caught = rt.catchUp(store.state.sessions[other.id]);
  assert.match(caught, /You: Make it blue\./);
  assert.match(caught, /@alpha showed an app “A”/);
});

test('#49: the browser’s reducer moves the item exactly as the server’s does', () => {
  const s = emptyState();
  const tid = 'th';
  apply(s, 'item.add', { threadId: tid, item: { id: 'a', kind: 'block' } });
  apply(s, 'item.add', { threadId: tid, item: { id: 'b', kind: 'agent' } });
  apply(s, 'item.move', { threadId: tid, id: 'a', stub: { id: 's', kind: 'moved', itemId: 'a' }, patch: { turnId: 't2' } });
  assert.deepEqual(
    s.items[tid].map((i) => i.id),
    ['s', 'b', 'a'],
  );
  assert.equal(s.items[tid][2].turnId, 't2');
  // An item that isn’t there moves nothing.
  apply(s, 'item.move', { threadId: tid, id: 'nope', stub: { id: 's2' }, patch: {} });
  assert.equal(s.items[tid].length, 3);
});
