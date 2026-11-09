// A host’s badge (shared/host-badge.mjs): its short name, or the first part of its machine’s name, never past
// SHORT_MAX characters, the checks a short name passes before it’s saved, and the runtime keeping it on its host.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { badgeOf, checkShortName, REMOVED_BADGE, SHORT_MAX } from '../shared/host-badge.mjs';
import { FINE, HOSTILE } from './hidden-chars-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

test('an agent whose host was removed gets a fixed word, not a cut of “a removed host”', () => {
  assert.equal(badgeOf({ name: 'a removed host', removed: true }), REMOVED_BADGE);
  assert.equal(REMOVED_BADGE, 'removed');
});

test('a host’s short name is its badge', () => {
  assert.equal(badgeOf({ name: 'me@dev-box.corp.example.com', short: 'gpu' }), 'gpu');
});

test('without one, the badge is the first label of the machine’s name, cut to the limit', () => {
  assert.equal(badgeOf({ name: 'me@dev-box.corp.example.com' }), 'dev-box');
  assert.equal(badgeOf({ name: 'buildfarm-west-2.example.com' }), 'buildfar');
  assert.equal(badgeOf({ name: 'devbox' }), 'devbox');
  assert.equal(badgeOf({ name: 'me@db' }), 'db', 'a short machine name is a short badge');
  assert.equal(Array.from(badgeOf({ name: 'a-very-long-ssh-alias' })).length, SHORT_MAX);
});

test('an IP address keeps its end, where addresses on one network differ', () => {
  assert.equal(badgeOf({ name: 'me@10.20.30.140' }), '0.30.140');
  assert.equal(badgeOf({ name: 'me@[fe80::1:2:3]' }), '0::1:2:3');
  assert.equal(badgeOf({ name: 'me@[fe80::1:2:3%25en0]' }), '0::1:2:3', 'without its zone');
  assert.equal(badgeOf({ name: 'fe80::1:2:3%en0' }), '0::1:2:3');
});

test('a short name is trimmed, at most SHORT_MAX characters, and an empty one clears it', () => {
  assert.deepEqual(checkShortName('  gpu  '), { ok: true, value: 'gpu' });
  assert.deepEqual(checkShortName(''), { ok: true, value: '' });
  assert.equal(checkShortName('ninechars').ok, false);
  assert.equal(checkShortName('a\nb').ok, false);
  assert.equal(checkShortName('gpu\u202E').ok, false, 'a right-to-left override');
  assert.equal(checkShortName('g\u200Bpu').ok, false, 'a zero width space');
  assert.deepEqual(checkShortName('db'), { ok: true, value: 'db' }, 'no least length');
  assert.equal(checkShortName(8).ok, false);
});

test('the runtime keeps a host’s short name, keeps it through other changes, and clears it when emptied', () => {
  const adapter = { name: 'mock', deliver: async () => {} };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store: new Store(null),
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [] },
  });
  const h = rt.addHost({ name: 'me@dev-box.corp.example.com', short: ' gpu ' });
  assert.equal(rt.s.hosts[h.id].short, 'gpu', 'trimmed');
  rt.updateHost(h.id, { settings: { forwardAgent: true } });
  assert.equal(rt.s.hosts[h.id].short, 'gpu', 'a change to its settings keeps it');
  assert.throws(
    () => rt.updateHost(h.id, { short: 'too-long-name' }),
    (e) => e.status === 422 && /the most is 8/.test(e.message),
  );
  rt.updateHost(h.id, { short: '' });
  assert.equal('short' in rt.s.hosts[h.id], false, 'an empty one clears it');
  assert.equal(badgeOf(rt.s.hosts[h.id]), 'dev-box');
});

const UNSEEN_ERROR = 'A short name can’t contain control or invisible characters, such as a new line or a zero width space.';

test('#1052 a short name with a control character, one that hides or reorders text, or a lone surrogate is refused', () => {
  // Each between two letters, so trim() can’t take it.
  assert.deepEqual(
    Object.entries(HOSTILE).map(([what, c]) => [what, checkShortName(`a${c}b`)]),
    Object.keys(HOSTILE).map((what) => [what, { ok: false, error: UNSEEN_ERROR }]),
  );
});

test('#1052 a short name of letters, accents, CJK or punctuation is kept as it is', () => {
  for (const s of FINE) assert.deepEqual(checkShortName(s), { ok: true, value: s }, s);
});

test('#1052 the runtime refuses a host’s short name with a Hangul filler, and keeps the one it had', () => {
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store: new Store(null),
    adapters: new AdapterRegistry().register({ name: 'mock', deliver: async () => {} }),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [] },
  });
  assert.throws(
    () => rt.addHost({ name: 'me@dev-box', short: 'ab\u3164' }),
    (e) => e.status === 422 && e.message === UNSEEN_ERROR,
  );
  assert.deepEqual(Object.keys(rt.s.hosts), [], 'nothing was added');
  const h = rt.addHost({ name: 'me@dev-box', short: 'gpu' });
  assert.throws(
    () => rt.updateHost(h.id, { short: 'gp\uFE0Fu' }),
    (e) => e.status === 422 && e.message === UNSEEN_ERROR,
  );
  assert.equal(rt.s.hosts[h.id].short, 'gpu');
});

test('#1052 a short name stored before it was checked, which the check refuses, gives way to the destination’s badge', () => {
  assert.equal(badgeOf({ name: 'me@dev-box', short: 'a\u202Eb' }), 'dev-box');
  assert.equal(badgeOf({ name: 'me@dev-box', short: 'ab\u3164' }), 'dev-box');
  assert.equal(badgeOf({ name: 'me@dev-box', short: 'gpu' }), 'gpu', 'one the check keeps still shows');
  assert.equal(badgeOf({ name: 'me@dev-box', short: '' }), 'dev-box', 'an empty one is unset');
});

test('#1052 a host whose short name was stored before the check refused it can still be renamed and change settings', async (t) => {
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const dir = tempDir('host-badge-old-');
  const old = await new Store(dir).load();
  // As an earlier Postbox kept them: VS16, an emoji with it, and a Hangul filler.
  const stored = { '🖥️': 'ho_old1', '❤️': 'ho_old2', 'ab\u3164': 'ho_old3' };
  for (const [short, id] of Object.entries(stored)) old.emit('host', { id, name: `me@${id}`, short, settings: {}, createdAt: 1 });
  await old.close();
  const store = await new Store(dir).load();
  t.after(() => store.close());
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'mock', deliver: async () => {} }),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [] },
  });
  for (const [short, id] of Object.entries(stored)) {
    assert.equal(rt.updateHost(id, { settings: { forwardAgent: true } }).short, short, `${short}: a change to its settings keeps it`);
    assert.equal(rt.s.hosts[id].settings.forwardAgent, true, `${short}: and saves the settings`);
    assert.equal(rt.updateHost(id, { name: `me@${id}-renamed` }).short, short, `${short}: a rename keeps it`);
    assert.equal(rt.s.hosts[id].name, `me@${id}-renamed`);
  }
  assert.throws(
    () => rt.updateHost('ho_old1', { short: 'gp\uFE0Fu' }),
    (e) => e.status === 422 && e.message === UNSEEN_ERROR,
    'a new short name is still checked',
  );
  assert.equal(rt.s.hosts.ho_old1.short, '🖥️', 'and the refused one isn’t kept');
});
