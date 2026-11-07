// A host’s badge (shared/host-badge.mjs): its short name, or the first part of its machine’s name, never past
// SHORT_MAX characters, the checks a short name passes before it’s saved, and the runtime keeping it on its host.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { badgeOf, checkShortName, REMOVED_BADGE, SHORT_MAX } from '../shared/host-badge.mjs';

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
