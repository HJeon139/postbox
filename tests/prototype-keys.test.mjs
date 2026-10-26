// #352: an id from a request is a key the state has or nothing. The state's collections are plain objects in JSON, so
// constructor, toString or __proto__ once found Object, a method or Object.prototype: a write answered 200 and added
// an app with no id, and a read answered 500. Every route with an id in its path, read from the routers themselves so a
// new one is covered too, answers each of them without a 2xx or a 500, and the event log doesn't move.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { start } from '../server/index.mjs';
import { buildEvent } from '../shared/events.mjs';
import { apply, emptyState, ownState } from '../shared/state.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';

const PORT = 4991;
const KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
const ROUTERS = ['server/index.mjs', 'server/session-routes.mjs', 'server/telemetry-routes.mjs'];
// The page's beacons: you're looking at a conversation, a diagram measured too small. They answer ok for a thread or an
// item they don't know, whatever its id, so they're held to writing nothing, not to refusing.
const BEACONS = ['^\\/api\\/threads\\/([^/]+)\\/view$', '^\\/api\\/threads\\/([^/]+)\\/items\\/([^/]+)\\/diagram$'];
/** The collection a route's first id is a record of, by the route's start. */
const FIRST = { '\\/api\\/threads\\/': 'threads', '\\/api\\/sessions\\/': 'sessions', '\\/api\\/apps\\/': 'apps', '\\/api\\/projects\\/': 'projects' };

const sources = () => ROUTERS.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

/**
 * Every route whose path takes an id, as { method, pattern }: the regex of each `path.match(/^…$/)` and the method its
 * line compares with, GET when it compares with none.
 */
function routes() {
  const found = [];
  for (const src of sources())
    for (const m of src.matchAll(/path\.match\(\/(\^.*?\$)\/\)\)(?:\s*&&\s*(?:req\.)?method\s*===\s*'(\w+)')?/g))
      if (m[1].includes('([^/]+)')) found.push({ method: m[2] ?? 'GET', pattern: m[1] });
  return found;
}

/** The paths a route's pattern makes with these ids in its slots, in order: (\d+) is 1, and each (a|b) a path of its own. */
function paths(pattern, ids) {
  let i = 0;
  let out = [
    pattern
      .slice(1, -1)
      .replaceAll('\\/', '/')
      .replaceAll('([^/]+)', () => encodeURIComponent(ids[i++]))
      .replaceAll('(\\d+)', '1'),
  ];
  const ALT = /\(([\w-]+(?:\|[\w-]+)+)\)/;
  for (let alt = ALT.exec(out[0]); alt; alt = ALT.exec(out[0])) out = out.flatMap((p) => alt[1].split('|').map((w) => p.replace(alt[0], w)));
  return out;
}

/**
 * The ids to try in a route's slots: the key in every one, and, for a route with more than one, a real record's id first
 * with the key after it, so the lookup of the second id is reached too.
 */
function idSets(pattern, key) {
  const n = pattern.split('([^/]+)').length - 1;
  const sets = [Array(n).fill(key)];
  const kind = Object.entries(FIRST).find(([start]) => pattern.startsWith(`^${start}`))?.[1];
  const real = kind && Object.keys(app.store.state[kind])[0];
  if (n > 1 && real) sets.push([real, ...Array(n - 1).fill(key)]);
  return sets;
}

let dir;
let app;
let cookie;
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-proto-'));
  app = await start({ port: PORT, dataDir: join(dir, 'data'), fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false });
  cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

test('#352: every route with an id is found, so a route written another way fails here rather than going untried', () => {
  const written = sources().reduce((n, src) => n + (src.match(/path\.match\(\/\^[^\n]*?\(\[\^\/\]\+\)/g) ?? []).length, 0);
  assert.ok(written >= 40, `the routers have ${written} routes with an id`);
  assert.equal(routes().length, written);
});

test('#352: constructor, toString, __proto__ and hasOwnProperty as an id are refused, without a 500, and write nothing', async () => {
  const wrong = [];
  for (const { method, pattern } of routes())
    for (const key of KEYS)
      for (const ids of idSets(pattern, key))
        for (const path of paths(pattern, ids)) {
          const seq = app.store.state.seq;
          const headers = method === 'GET' ? {} : { cookie, origin: app.origin, 'content-type': 'application/json' };
          const res = await call({ method, path, headers, body: method === 'GET' ? undefined : {} });
          // The router's own 404, for a path no route took, would mean the route under test was never reached.
          const unrouted = /^There’s nothing at /.test(res.json?.error ?? '');
          const refused = res.status >= 400 || BEACONS.includes(pattern);
          if (!refused || unrouted || res.status >= 500 || app.store.state.seq !== seq)
            wrong.push(`${method} ${path}: ${res.status}${unrouted ? ' (no route)' : ''}, ${app.store.state.seq - seq} events`);
        }
  assert.deepEqual(wrong, []);
  // Nothing reached the state under a key it wasn't given.
  for (const c of ['apps', 'threads', 'sessions', 'files', 'personas', 'projects', 'boilerplates', 'schedules'])
    assert.deepEqual(
      Object.keys(app.store.state[c]).filter((k) => k === 'undefined' || KEYS.includes(k)),
      [],
      c,
    );
});

test('#352: the state has only its own records, fresh, reloaded from JSON, and for keys an event brings', () => {
  const saved = emptyState();
  apply(saved, 'app', { id: 'a1', title: 'One' });
  apply(saved, 'glossary', { threadId: 't', entry: { key: 'k', term: 'K' } });
  for (const s of [emptyState(), ownState(JSON.parse(JSON.stringify(saved)))])
    for (const c of [
      'projects',
      'personas',
      'boilerplates',
      'threads',
      'sessions',
      'items',
      'apps',
      'files',
      'datasets',
      'schedules',
      'glossary',
      'work',
      'hosts',
      'hostStatus',
    ])
      for (const key of KEYS) assert.equal(s[c][key], undefined, `${c}[${key}]`);
  const reloaded = ownState(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.apps.a1.title, 'One', 'its records survive the reload');
  assert.equal(reloaded.glossary.t.toString, undefined, 'a conversation’s glossary too');
  // A host's collections made by its first event, in a state from before there were any (#120), are maps too.
  const before = emptyState();
  delete before.hosts;
  delete before.hostStatus;
  apply(before, 'host', { id: 'h1', name: 'devbox' });
  apply(before, 'host.status', { id: 'h1', status: { state: 'disconnected' } });
  assert.equal(Object.getPrototypeOf(before.hosts), null);
  assert.equal(Object.getPrototypeOf(before.hostStatus), null);
  // A glossary term an agent names __proto__ is a term, not the map's prototype.
  const g = emptyState();
  apply(g, 'glossary', { threadId: 't', entry: { key: '__proto__', term: 'proto' } });
  assert.equal(Object.getPrototypeOf(g.glossary.t), null);
  assert.deepEqual(
    Object.entries(g.glossary.t).map(([k, e]) => [k, e.term]),
    [['__proto__', 'proto']],
  );
});

test('#352: a form field an agent names constructor or toString reads only the value sent for it', () => {
  const block = {
    id: 'f',
    type: 'form',
    version: 1,
    fallback: 'x',
    fields: [
      { id: 'constructor', label: 'Builder', kind: 'text' },
      { id: 'toString', label: 'Words', kind: 'text', required: true },
    ],
  };
  // Left empty, the optional one is fine and the required one says so, as for any field.
  const empty = buildEvent(block, 'submit', {});
  assert.equal(empty.ok, false);
  assert.deepEqual(Object.keys(empty.fieldErrors), ['toString']);
  const sent = buildEvent(block, 'submit', { constructor: 'Ada', toString: 'hi' });
  assert.equal(sent.ok, true, sent.error);
});
