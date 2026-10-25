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
import { apply, emptyState, ownState } from '../shared/state.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';

const PORT = 4991;
const KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
const ROUTERS = ['server/index.mjs', 'server/session-routes.mjs', 'server/telemetry-routes.mjs'];
// The page's beacons: you're looking at a conversation, a diagram measured too small. They answer ok for a thread or an
// item they don't know, whatever its id, so they're held to writing nothing, not to refusing.
const BEACONS = [/\/view$/, /\/diagram$/];

/**
 * Every route whose path takes an id, as { method, pattern }: the regex of each `path.match(/^…$/)` and the method its
 * line compares with, GET when it compares with none.
 */
function routes() {
  const found = [];
  for (const file of ROUTERS) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/path\.match\(\/(\^.*?\$)\/\)\)(?:\s*&&\s*(?:req\.)?method\s*===\s*'(\w+)')?/g))
      if (m[1].includes('([^/]+)')) found.push({ method: m[2] ?? 'GET', pattern: m[1] });
  }
  return found;
}

/** The paths a route's pattern makes with key in every id: (\d+) is 1, and each alternative of (a|b) is a path of its own. */
function paths(pattern, key) {
  let out = [pattern.slice(1, -1).replaceAll('\\/', '/').replaceAll('([^/]+)', encodeURIComponent(key)).replaceAll('(\\d+)', '1')];
  for (let alt = /\((\w+(?:\|\w+)+)\)/.exec(out[0]); alt; alt = /\((\w+(?:\|\w+)+)\)/.exec(out[0]))
    out = out.flatMap((p) => alt[1].split('|').map((w) => p.replace(alt[0], w)));
  return out;
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

test('#352: the routers have routes with ids to try', () => {
  // A change to how routes are written would leave this test trying nothing.
  assert.ok(routes().length >= 40, `found ${routes().length} routes with an id`);
});

test('#352: constructor, toString, __proto__ and hasOwnProperty as an id answer with neither a 2xx nor a 500, and write nothing', async () => {
  const wrong = [];
  for (const { method, pattern } of routes())
    for (const key of KEYS)
      for (const path of paths(pattern, key)) {
        const seq = app.store.state.seq;
        const headers = method === 'GET' ? {} : { cookie, origin: app.origin, 'content-type': 'application/json' };
        const res = await call({ method, path, headers, body: method === 'GET' ? undefined : {} });
        const refused = res.status >= 400 || BEACONS.some((b) => b.test(path));
        if (!refused || res.status >= 500 || app.store.state.seq !== seq) wrong.push(`${method} ${path}: ${res.status}, ${app.store.state.seq - seq} events`);
      }
  assert.deepEqual(wrong, []);
  // Nothing reached the state under a key it wasn't given.
  for (const c of ['apps', 'threads', 'sessions', 'files', 'personas', 'projects'])
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
    for (const c of ['projects', 'personas', 'threads', 'sessions', 'items', 'apps', 'files', 'datasets', 'schedules', 'glossary', 'work'])
      for (const key of KEYS) assert.equal(s[c][key], undefined, `${c}[${key}]`);
  const reloaded = ownState(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.apps.a1.title, 'One', 'its records survive the reload');
  assert.equal(reloaded.glossary.t.toString, undefined, 'a conversation’s glossary too');
  // A glossary term an agent names __proto__ is a term, not the map's prototype.
  const g = emptyState();
  apply(g, 'glossary', { threadId: 't', entry: { key: '__proto__', term: 'proto' } });
  assert.equal(Object.getPrototypeOf(g.glossary.t), null);
  assert.deepEqual(
    Object.entries(g.glossary.t).map(([k, e]) => [k, e.term]),
    [['__proto__', 'proto']],
  );
});
