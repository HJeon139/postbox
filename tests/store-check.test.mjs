// What the store’s Redis would refuse, refused before anything is applied or broadcast (shared/storable.mjs; the
// integrator’s review of #553, blocker 2): RedisJSON 8.10.3 refuses a document nested 128 levels deep (“recursion limit
// exceeded”) and a string holding a lone surrogate (“unexpected end of hex escape”), and an optimistic emit that
// reached it wedged the store. These run the in-memory store; tests/store-write.test.mjs covers the Redis side.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { LIMITS } from '../shared/limits.mjs';
import { depthOf, EVENT_DEPTH, storable } from '../shared/storable.mjs';

/** A value nested n levels deep. @param {number} n */
const nested = (n) => {
  let v = /** @type {any} */ (1);
  for (let i = 0; i < n; i++) v = i % 2 ? [v] : { a: v };
  return v;
};

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
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(new Quiet()), corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'alpha' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const [se] = rt.sessionsIn(t.id);
  const tools = rt.toolsFor(se.id);
  tools.show_app({ id: 'ap', title: 'Explorer', code: '<p>1</p>' });
  return { store, rt, t, se };
}

test('depthOf counts a JSON text’s nesting, ignoring brackets inside strings', () => {
  assert.equal(depthOf('1'), 0);
  assert.equal(depthOf('{"a":[1,{"b":"[{[{"}]}'), 3);
  assert.equal(depthOf(JSON.stringify(nested(100))), 100);
  assert.equal(depthOf('"\\"[["'), 0);
});

test('storable refuses JSON past the depth limit and a lone surrogate, and names what to do', () => {
  assert.equal(storable(JSON.stringify(nested(LIMITS.jsonDepth))), null);
  const deep = storable(JSON.stringify(nested(LIMITS.jsonDepth + 1)));
  assert.match(deep?.message ?? '', new RegExp(`${LIMITS.jsonDepth + 1} levels deep.*up to ${LIMITS.jsonDepth}`));
  assert.equal(deep?.code, 'EUNSTORABLE');
  assert.equal(storable(JSON.stringify({ s: '😀', t: 'a\\ud800b' })), null, 'a pair, and the six characters \\ud800, are fine');
  assert.match(storable(JSON.stringify({ s: '😀'.slice(0, 1) }))?.message ?? '', /half of a character/);
});

test('an app’s saved state nested past the limit is refused with 422 before the store applies or broadcasts it', () => {
  const { store, rt } = setup();
  const seen = [];
  store.subscribe((ev) => seen.push(ev.type));
  const before = store.state.seq;
  assert.throws(
    () => rt.appState('ap', nested(LIMITS.jsonDepth + 1)),
    (e) => e.status === 422 && /levels deep/.test(e.message),
  );
  assert.equal(store.state.apps.ap.state, null, 'nothing applied');
  assert.equal(store.state.seq, before);
  assert.deepEqual(seen, [], 'nothing broadcast');
  rt.appState('ap', nested(LIMITS.jsonDepth));
  assert.equal(store.state.seq, before + 1, 'the next write goes through');
});

test('an app’s event with values nested past the limit is refused with 422, and the next event is delivered', () => {
  const { store, rt, t } = setup();
  const before = store.items(t.id).length;
  assert.throws(
    () => rt.appEvent('ap', 'pick', { v: nested(LIMITS.jsonDepth + 1) }),
    (e) => e.status === 422 && /levels deep/.test(e.message),
  );
  assert.equal(store.items(t.id).length, before, 'no voice line, no card');
  assert.equal(rt.appEvent('ap', 'pick', { v: nested(LIMITS.jsonDepth - 3) }).ok, true);
});

test('the store refuses a deep emit or commit before applying it, and repairs a string cut inside a character', async () => {
  const store = new Store(null);
  const seen = [];
  store.subscribe((ev) => seen.push(ev));
  // An event wraps an app’s value in a few levels of its own, so the store allows those on top of the agents’ limit.
  assert.throws(
    () => store.emit('settings', { deep: nested(EVENT_DEPTH) }),
    (e) => e.code === 'EUNSTORABLE',
  );
  await assert.rejects(store.commit([{ type: 'settings', data: { deep: nested(EVENT_DEPTH) } }]), (e) => e.code === 'EUNSTORABLE');
  assert.deepEqual(seen, []);
  assert.equal(store.state.settings.deep, undefined);
  store.emit('settings', { deep: nested(EVENT_DEPTH - 1) });
  assert.equal(seen.length, 1, 'one level less is taken');
  seen.length = 0;
  // Postbox cuts agents’ text to a length everywhere (`.slice(0, n)`), which can cut a character in two; RedisJSON
  // refuses the half, so the store stands in the replacement character.
  store.emit('settings', { cut: `a${'😀'.slice(0, 1)}b`, list: ['😀'.slice(1)] });
  assert.equal(store.state.settings.cut, 'a�b');
  assert.deepEqual(store.state.settings.list, ['�']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.cut, 'a�b', 'the browser hears what Redis will hold');
});
