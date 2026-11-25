// What an app publishes for its agent (#1478) is Postbox’s first private data: the state key `published`, with its
// private event `app.publish` (designs/architecture/security-boundaries.md, “What reaches the browser”). The notes an app
// sends without a click (#1488) are the second: `appNotes`, with `app.note`. Only the agent’s read_app reads either. A
// unique secret is published, and another sent as a note, through the page’s own routes, and then looked for, as text, in
// everything that leaves the process for a page or a host: /api/state, the event stream’s backlog and live frames,
// every GET route, and a remote host’s snapshot. The source-text check in tests/app-publish.test.mjs can’t see a key
// built at run time or a spread of the whole state; this sees what each answer holds.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { snapshotOf } from '../server/remote/turns-snapshot.mjs';
import * as arrange from './arrange.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4452;
const host = `127.0.0.1:${PORT}`;
const SECRET = `published-secret-${randomUUID()}`;
const NOTE_SECRET = `note-secret-${randomUUID()}`;
/** Whether a text carries either secret. @param {string} text */
const leaks = (text) => text.includes(SECRET) || text.includes(NOTE_SECRET);
/** @type {any} */
let app;
/** @type {{ thread: string, app: string, item: string, session: string, persona: string, project: string, host: string }} */
let ids;
/** The seq of the publish’s app.publish event and of the note’s app.note, and the seq before the publish. */
let seq = 0;
let noteSeq = 0;
let sinceBefore = 0;
/** Frames a page’s stream, opened before the publish, heard live. @type {string[]} */
const live = [];

const call = (/** @type {any} */ r) => fakeRequest(app.handle, { host, ...r });

/** Opens /api/stream as the page does, writing each frame into `out`; it stays open until the server closes. */
function openStream(/** @type {string} */ query, /** @type {string[]} */ out) {
  const req = Object.assign(Readable.from([]), { method: 'GET', url: `/api/stream?${query}`, headers: { host }, socket: { remoteAddress: '127.0.0.1' } });
  const res = {
    writeHead() {},
    write: (/** @type {string} */ s) => out.push(String(s)) > 0,
    end() {},
    once() {},
    on() {},
    destroy() {},
  };
  app.handle(req, res);
}

/** Waits, without a fixed sleep, until `ok()` holds or five seconds have passed. */
async function until(/** @type {() => boolean} */ ok) {
  const end = Date.now() + 5000;
  while (!ok() && Date.now() < end) await new Promise((r) => setImmediate(r));
}

before(async () => {
  const dir = tempDir('pb-published-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false });
  const thread = Object.values(app.store.state.threads).find((/** @type {any} */ t) => t.title === 'Asset explorer');
  const se = arrange.sessionsIn(app.rt, thread.id)[0];
  app.rt.toolsFor(se.id).show_app({ id: 'secret-app', title: 'Secret app', code: '<p>x</p>', permissions: [] });
  const shown = app.store.state.apps['secret-app'];
  ids = {
    thread: thread.id,
    app: 'secret-app',
    item: shown.itemId,
    session: se.id,
    persona: se.personaId,
    project: thread.projectId,
    host: app.rt.addHost({ name: 'host.example.com' }).id,
  };
  const page = await call({ path: '/', headers: NAVIGATION });
  const cookie = page.headers['set-cookie'].split(';')[0];
  sinceBefore = app.store.state.seq;
  openStream(`since=${sinceBefore}&open=${ids.thread}`, live);
  const r = await call({ method: 'POST', path: `/api/apps/${ids.app}/publish`, body: { data: { note: SECRET } }, cookie });
  assert.equal(r.status, 200, r.text);
  seq = app.store.since(sinceBefore).find((/** @type {any} */ e) => e.type === 'app.publish')?.seq ?? 0;
  assert.ok(seq > 0, 'the publish is in the store’s history');
  assert.equal(app.store.state.published[ids.app].data.note, SECRET, 'the secret is in the store, so its absence below means kept out');
  const noted = await call({ method: 'POST', path: `/api/apps/${ids.app}/note`, body: { action: 'secret', values: { note: NOTE_SECRET } }, cookie });
  assert.equal(noted.status, 200, noted.text);
  noteSeq = app.store.since(sinceBefore).find((/** @type {any} */ e) => e.type === 'app.note')?.seq ?? 0;
  assert.ok(noteSeq > 0, 'the note is in the store’s history');
  assert.equal(app.store.state.appNotes[ids.app].notes[0].values.note, NOTE_SECRET, 'and the note’s secret');
});
after(async () => {
  await app?.close();
});

test('#1478, #1488 /api/state carries nothing an app published or noted', async () => {
  const r = await call({ path: '/api/state' });
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Secret app'), 'the app itself is there');
  assert.ok(!leaks(r.text), '/api/state carries what the app published or noted');
});

test('#1478, #1488 the event stream’s live and backlog frames carry nothing an app published or noted: each event is a cursor', async () => {
  const cursor = `id: ${seq}\nevent: cursor\ndata: {}\n\n`;
  const noteCursor = `id: ${noteSeq}\nevent: cursor\ndata: {}\n\n`;
  await until(() => live.join('').includes(noteCursor));
  assert.ok(!leaks(live.join('')), 'no live frame');
  assert.ok(live.join('').includes(cursor), 'the page heard the publish live, as a cursor');
  assert.ok(live.join('').includes(noteCursor), 'and the note');
  const backlog = /** @type {string[]} */ ([]);
  openStream(`since=${sinceBefore}`, backlog);
  await until(() => backlog.join('').includes(noteCursor));
  assert.ok(!leaks(backlog.join('')), 'no backlog frame');
  assert.ok(backlog.join('').includes(cursor), 'the backlog has the publish, as a cursor');
  assert.ok(backlog.join('').includes(noteCursor), 'and the note');
});

test('#1478, #1488 a remote host’s snapshot of the conversation carries nothing an app published or noted', () => {
  const snap = JSON.stringify(snapshotOf(/** @type {any} */ ({ rt: app.rt }), app.rt.s.sessions[ids.session]));
  assert.ok(snap.includes(ids.item), 'the snapshot holds the app’s item');
  assert.ok(!leaks(snap), 'the snapshot carries what the app published or noted');
});

// Every GET route, by the path test in server/index.mjs or its route modules, with a path that reaches it and the status
// that path answers. A route added without a case here fails the test below, so none skips the check.
/** @type {Record<string, { paths: (i: typeof ids) => string[], status: number }>} */
const GET_ROUTES = {
  '/': { paths: () => ['/'], status: 200 },
  '/index.html': { paths: () => ['/index.html'], status: 200 },
  '/favicon.svg': { paths: () => ['/favicon.svg'], status: 200 },
  "startsWith '/media/'": { paths: () => ['/media/favicon.svg'], status: 200 },
  'startsWith prefix': { paths: () => ['/app/js/client.mjs', '/app/workbench.css', '/shared/state.mjs', '/kit/kit.js'], status: 200 },
  "startsWith '/sandbox/'": { paths: (i) => [`/sandbox/app/${i.app}/1`], status: 200 },
  '^\\/sandbox\\/app\\/([^/]+)\\/(\\d+)$': { paths: (i) => [`/sandbox/app/${i.app}/1`, `/sandbox/app/${i.app}/1?check`], status: 200 },
  '/sandbox/mermaid': { paths: () => ['/sandbox/mermaid'], status: 200 },
  // The agents’ MCP endpoint takes POST alone: a GET is refused before anything is read.
  '/mcp': { paths: () => ['/mcp'], status: 405 },
  '/api/state': { paths: () => ['/api/state'], status: 200 },
  // Who is looking and the people here (#558): none of the store’s private keys.
  '/api/me': { paths: () => ['/api/me'], status: 200 },
  '/api/stream': { paths: () => [], status: 200 }, // read as a stream above
  '^\\/api\\/threads\\/([^/]+)\\/(items|search)$': {
    paths: (i) => [`/api/threads/${i.thread}/items?asks=20&head=20`, `/api/threads/${i.thread}/search?q=secret`],
    status: 200,
  },
  '/api/mcp-servers': { paths: (i) => [`/api/mcp-servers?personaId=${i.persona}&projectId=${i.project}`], status: 200 },
  '/api/skills': { paths: (i) => [`/api/skills?personaId=${i.persona}&projectId=${i.project}`], status: 200 },
  '/api/permissions': {
    paths: (i) => [`/api/permissions?sessionId=${i.session}`, `/api/permissions?personaId=${i.persona}&projectId=${i.project}`],
    status: 200,
  },
  '^\\/api\\/threads\\/([^/]+)\\/work\\/git$': { paths: (i) => [`/api/threads/${i.thread}/work/git`], status: 200 },
  // A file’s diff, a command’s output, a room asset, a changed file, an app’s data file, a review’s image and an upload
  // answer one file’s bytes, by id; this room has none, so each answers its 404, never the state.
  '^\\/api\\/threads\\/([^/]+)\\/work\\/files\\/([^/]+)\\/diff$': { paths: (i) => [`/api/threads/${i.thread}/work/files/wf_none/diff`], status: 404 },
  '^\\/api\\/threads\\/([^/]+)\\/work\\/commands\\/([^/]+)\\/output$': {
    paths: (i) => [`/api/threads/${i.thread}/work/commands/wk_none/output`],
    status: 404,
  },
  '^\\/api\\/threads\\/([^/]+)\\/assets\\/([^/]+)$': { paths: (i) => [`/api/threads/${i.thread}/assets/as_none`], status: 404 },
  '^\\/api\\/threads\\/([^/]+)\\/work\\/files\\/([^/]+)\\/content$': { paths: (i) => [`/api/threads/${i.thread}/work/files/wf_none/content`], status: 404 },
  '^\\/api\\/apps\\/([^/]+)\\/files\\/([^/]+)$': { paths: (i) => [`/api/apps/${i.app}/files/none.json`], status: 404 },
  '^\\/api\\/threads\\/([^/]+)\\/items\\/([^/]+)\\/files\\/([^/]+)$': {
    paths: (i) => [`/api/threads/${i.thread}/items/${i.item}/files/none.png`],
    status: 404,
  },
  '^\\/api\\/files\\/([^/]+)$': { paths: () => ['/api/files/fi_none'], status: 404 },
  '/api/claude-sessions': { paths: () => ['/api/claude-sessions'], status: 200 },
  '^\\/api\\/projects\\/([^/]+)\\/files$': { paths: (i) => [`/api/projects/${i.project}/files`], status: 200 },
  '^\\/api\\/hosts\\/([^/]+)\\/install$': { paths: (i) => [`/api/hosts/${i.host}/install`], status: 200 },
};

/**
 * The GET routes server/index.mjs has, and the route modules it calls: each path test on a line that names no write
 * method, as `path === '…'`, `path.match(/…/)` or `path.startsWith(…)`.
 */
async function getRoutesInSource() {
  const dir = fileURLToPath(new URL('../server/', import.meta.url));
  const files = ['index.mjs', 'room-files.mjs', 'stored-files.mjs', ...(await readdir(dir)).filter((f) => f.endsWith('-routes.mjs'))];
  const src = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n');
  const found = new Set();
  for (const line of src.split('\n')) {
    if (/method === '(POST|PATCH|PUT|DELETE)'/.test(line) || /const body =/.test(line)) continue;
    for (const m of line.matchAll(/path === '([^']+)'/g)) found.add(m[1]);
    for (const m of line.matchAll(/path\.match\(\/(.+?)\/\)/g)) found.add(m[1]);
    for (const m of line.matchAll(/path\.startsWith\(([^)]+)\)/g)) found.add(`startsWith ${m[1]}`);
  }
  return [...found];
}

test('#1478 every GET route has a case here', async () => {
  const found = await getRoutesInSource();
  assert.ok(found.length >= 25, `Only ${found.length} GET routes were found; the reader is probably broken.`);
  assert.deepEqual(
    found.filter((r) => !Object.hasOwn(GET_ROUTES, r)),
    [],
    'Add these routes to GET_ROUTES so the check covers them.',
  );
  assert.deepEqual(
    Object.keys(GET_ROUTES).filter((r) => !found.includes(r)),
    [],
    'These cases name routes the server no longer has.',
  );
});

test('#1478, #1488 no GET route answers with anything an app published or noted', async () => {
  for (const [route, { paths, status }] of Object.entries(GET_ROUTES)) {
    for (const path of paths(ids)) {
      const r = await call({ path });
      assert.equal(r.status, status, `${path} (${route}): ${r.text.slice(0, 200)}`);
      assert.ok(!leaks(r.text), `${path} carries what the app published or noted`);
    }
  }
});
