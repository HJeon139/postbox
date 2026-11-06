// The reducer's contract (#609, designs/508/609-reducer-throw.md): a handler that throws leaves the state as it was, so
// an event the store holds as rejected changed nothing, on the server, on its replay and on the page. The inputs are
// derived, not listed: one valid payload per type, then that payload with each key left out at every depth, and
// `undefined`, `null` and `{}`. Each valid payload is the shape the reducer's own case reads, as the existing specs
// emit it (tests/state.test.mjs and the specs of each producer).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, EVENTS, emptyState, map } from '../shared/state.mjs';

const sha = (/** @type {string} */ c) => c.repeat(64);
const version = (/** @type {number} */ v, /** @type {string} */ c) => ({
  v,
  sha256: sha(c),
  size: 1,
  type: 'text/plain',
  isText: true,
  author: 'dev',
  at: v,
  base: v - 1 || null,
});

/**
 * A state holding what the valid payloads below name: a thread `t` with an item, a work entry, a session, and an asset
 * `as` in its room with version 1, made through the reducer so the room's index is as the store keeps it.
 */
function base() {
  const s = emptyState();
  s.threads.t = { id: 't', members: [] };
  s.items.t = [{ id: 'i', kind: 'agent', text: 'a', activity: { steps: [{ id: 'st', state: 'running' }] } }];
  s.work.t = [{ id: 'w', kind: 'turn', status: 'running' }];
  s.sessions.se = { id: 'se', threadId: 't', handle: 'dev' };
  s.glossary.t = map({ k: { key: 'k', term: 'K', definition: 'a k' } });
  s.hosts.h = { id: 'h', name: 'host' };
  apply(s, 'asset', { id: 'as', room: 't', name: 'a.md', created: 1 });
  apply(s, 'asset.version', { id: 'as', version: version(1, 'a'), prunes: [], released: [] });
  return s;
}

/** One valid payload for every event type the reducer applies on `main`. */
export const VALID = {
  settings: { theme: 'dark' },
  project: { id: 'p', name: 'P' },
  persona: { id: 'pe', handle: 'pe' },
  boilerplate: { id: 'b', text: 'B' },
  thread: { id: 't2', members: [] },
  session: { id: 'se2', threadId: 't', handle: 'two' },
  'session.patch': { id: 'se', patch: { handle: 'dev2' }, unset: ['threadId'] },
  app: { id: 'a', title: 'A', versions: [] },
  file: { id: 'f', name: 'f.txt' },
  dataset: { id: 'd', title: 'D' },
  schedule: { id: 'sc', at: 1 },
  glossary: { threadId: 't', entry: { key: 'k2', term: 'K2', definition: 'a k2' } },
  'item.add': { threadId: 't', item: { id: 'i2', kind: 'user', text: 'b' } },
  'item.patch': { threadId: 't', id: 'i', patch: { text: 'c' }, activityStep: { id: 'st', state: 'done' } },
  'item.move': { threadId: 't', id: 'i', stub: { id: 'm', kind: 'moved', itemId: 'i' }, patch: { at: 2 } },
  'item.text': { threadId: 't', id: 'i', text: 'd' },
  'work.add': { convId: 't', entry: { id: 'w2', kind: 'command' } },
  'work.patch': { convId: 't', id: 'w', patch: { status: 'done' } },
  remove: { kind: 'thread', id: 't' },
  notify: { text: 'hi' },
  host: { id: 'h2', name: 'host two' },
  'host.status': { id: 'h', status: { state: 'connected' } },
  asset: { id: 'as', room: 't', name: 'b.md', created: 1 },
  'asset.version': { id: 'as', version: version(2, 'b'), prunes: [1], released: [sha('a')] },
  'asset.erase': { room: 't', at: 3 },
  'asset.released': { hashes: [sha('a')] },
};

/** Every key path of a payload, as arrays. */
const paths = (v, at = []) => (v && typeof v === 'object' ? Object.keys(v).flatMap((k) => [[...at, k], ...paths(v[k], [...at, k])]) : []);
/** The payload with the key at `path` left out. */
function without(v, path) {
  const out = structuredClone(v);
  let o = out;
  for (const p of path.slice(0, -1)) o = o[p];
  if (Array.isArray(o)) o.splice(Number(path.at(-1)), 1);
  else delete o[path.at(-1)];
  return out;
}

test('VALID has a payload for every EVENTS type, so a new type fails here until it has one (#702)', () => {
  assert.deepEqual(Object.keys(VALID).sort(), Object.keys(EVENTS).sort());
});

test('every event type has a valid payload here, which applies without a throw', () => {
  for (const [type, d] of Object.entries(VALID)) assert.doesNotThrow(() => apply(base(), type, structuredClone(d)), type);
});

test('a handler that throws leaves the state byte-equal: each key left out, and undefined, null and {}', () => {
  const broken = [];
  for (const [type, d] of Object.entries(VALID)) {
    const inputs = [undefined, null, {}, ...paths(d).map((p) => without(d, p))];
    for (const input of inputs) {
      const s = base();
      const before = JSON.stringify(s);
      try {
        apply(s, type, structuredClone(input));
      } catch {
        if (JSON.stringify(s) !== before) broken.push(`${type} ${JSON.stringify(input)}`);
      }
    }
  }
  assert.deepEqual(broken, [], 'each of these changed the state and then threw');
});
