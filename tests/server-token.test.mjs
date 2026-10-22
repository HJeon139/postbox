// #74: every write to Postbox’s API needs the page’s token, which the page gets in a cookie when it loads `/`.
// The router is called with fake requests (start({ listen: false })), since tests can’t open sockets.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4439;
let app;
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-token-'));
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false });
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

/** The token, as a browser gets it: by opening the page. */
const pageCookie = async () => {
  const r = await call({ path: '/', headers: NAVIGATION });
  assert.equal(r.status, 200);
  const set = r.headers['set-cookie'];
  assert.match(set, new RegExp(`^pb_token_${PORT}=[\\w-]{40,}; HttpOnly; SameSite=Strict; Path=/$`));
  return set.split(';')[0];
};

// Every write route, by its method and the path test in server/index.mjs, with paths that reach it. A route added
// to server/index.mjs without a case here fails the test below, so none can skip the token check.
const WRITE_ROUTES = {
  'POST /api/threads': ['/api/threads'],
  'DELETE ^\\/api\\/threads\\/([^/]+)$': ['/api/threads/th_none'],
  'PATCH ^\\/api\\/threads\\/([^/]+)$': ['/api/threads/th_none'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/undo-delete$': ['/api/threads/th_none/undo-delete'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/messages$': ['/api/threads/th_none/messages'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/view$': ['/api/threads/th_none/view'],
  'PATCH ^\\/api\\/threads\\/([^/]+)\\/queue\\/([^/]+)$': ['/api/threads/th_none/queue/q_none'],
  'DELETE ^\\/api\\/threads\\/([^/]+)\\/queue\\/([^/]+)$': ['/api/threads/th_none/queue/q_none'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/queue\\/([^/]+)\\/send$': ['/api/threads/th_none/queue/q_none/send'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/items\\/([^/]+)\\/act$': ['/api/threads/th_none/items/it_none/act'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/items\\/([^/]+)\\/topic$': ['/api/threads/th_none/items/it_none/topic'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/items\\/([^/]+)\\/share$': ['/api/threads/th_none/items/it_none/share'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/summarize$': ['/api/threads/th_none/summarize'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/items\\/([^/]+)\\/diagram$': ['/api/threads/th_none/items/it_none/diagram'],
  'POST ^\\/api\\/threads\\/([^/]+)\\/items\\/([^/]+)\\/retry$': ['/api/threads/th_none/items/it_none/retry'],
  'POST ^\\/api\\/sessions\\/([^/]+)\\/(stop|archive|restore|undo-delete)$': [
    '/api/sessions/se_none/stop',
    '/api/sessions/se_none/archive',
    '/api/sessions/se_none/restore',
    '/api/sessions/se_none/undo-delete',
  ],
  'DELETE ^\\/api\\/sessions\\/([^/]+)$': ['/api/sessions/se_none'],
  'POST /api/claude-sessions/attach': ['/api/claude-sessions/attach'],
  'POST /api/personas': ['/api/personas'],
  'PATCH ^\\/api\\/personas\\/([^/]+)$': ['/api/personas/pe_none'],
  'POST /api/permissions/rules': ['/api/permissions/rules'],
  'POST /api/permissions/folders': ['/api/permissions/folders'],
  'POST /api/permissions/mode': ['/api/permissions/mode'],
  'POST /api/projects': ['/api/projects'],
  'POST /api/files': ['/api/files'],
  'POST /api/corpus': ['/api/corpus'],
  'POST ^\\/api\\/apps\\/([^/]+)\\/(check|event|state|query)$': [
    '/api/apps/ap_none/check',
    '/api/apps/ap_none/event',
    '/api/apps/ap_none/state',
    '/api/apps/ap_none/query',
  ],
  'POST ^\\/api\\/schedules\\/([^/]+)\\/cancel$': ['/api/schedules/sc_none/cancel'],
  'PUT /api/settings': ['/api/settings'],
  'POST /api/demo/offline': ['/api/demo/offline'],
  'POST /api/demo/speed': ['/api/demo/speed'],
};

/** The write routes server/index.mjs has: each line that tests a path and a method other than GET. */
async function routesInSource() {
  const src = await readFile(fileURLToPath(new URL('../server/index.mjs', import.meta.url)), 'utf8');
  const found = [];
  const unread = [];
  for (const line of src.split('\n')) {
    if (!/req\.method === '(POST|PATCH|PUT|DELETE)'/.test(line) || /const body =/.test(line)) continue;
    const method = line.match(/req\.method === '(POST|PATCH|PUT|DELETE)'/)[1];
    const path = line.match(/path === '([^']+)'/)?.[1] ?? line.match(/path\.match\(\/(.+?)\/\)\)/)?.[1];
    if (path) found.push(`${method} ${path}`);
    else unread.push(line.trim());
  }
  return { found, unread };
}

test('#74: every write route in server/index.mjs has a case in the token test', async () => {
  const { found, unread } = await routesInSource();
  assert.deepEqual(unread, [], 'A line tests a write method, but its path couldn’t be read: write it as `if (path … && req.method === …)`.');
  assert.ok(found.length >= 25, `Only ${found.length} write routes were found; the reader is probably broken.`);
  const missing = found.filter((r) => !Object.hasOwn(WRITE_ROUTES, r));
  assert.deepEqual(missing, [], 'Add these routes to WRITE_ROUTES so the token test covers them.');
  const stale = Object.keys(WRITE_ROUTES).filter((r) => !found.includes(r));
  assert.deepEqual(stale, [], 'These cases name routes server/index.mjs no longer has.');
});

test('#74: a write without the page’s token gets 403 saying why, on every write route', async () => {
  for (const [route, paths] of Object.entries(WRITE_ROUTES)) {
    const method = route.split(' ')[0];
    for (const path of paths) {
      const r = await call({ method, path, body: {} });
      assert.equal(r.status, 403, `${method} ${path} without the token`);
      assert.match(r.json.error, /came from outside the Postbox page/, `${method} ${path}`);
      assert.equal(r.json.code, 'token');
      // A wrong token, or one from another launch, is refused the same way.
      const wrong = await call({ method, path, body: {}, cookie: `pb_token_${PORT}=${'x'.repeat(43)}` });
      assert.equal(wrong.status, 403, `${method} ${path} with a wrong token`);
    }
  }
});

test('#74: with the page’s token, every write route is reached', async () => {
  const cookie = await pageCookie();
  for (const [route, paths] of Object.entries(WRITE_ROUTES)) {
    const method = route.split(' ')[0];
    for (const path of paths) {
      // /api/files takes the file itself; an empty one is enough to reach the route.
      const r = await call({ method, path, body: path === '/api/files' ? undefined : {}, cookie: `other=1; ${cookie}` });
      assert.notEqual(r.status, 403, `${method} ${path}: ${r.text}`);
      assert.doesNotMatch(r.text, /There’s nothing at/, `${method} ${path} didn’t reach its route`);
    }
  }
});

test('#74: only a browser gets the token: a navigation or the page’s own fetch, never a bare request for /', async () => {
  const bare = await call({ path: '/' });
  assert.equal(bare.status, 200);
  assert.equal(bare.headers['set-cookie'], undefined, 'curl gets the page, not the token');
  // The page’s token refresh after a restart: a same-origin fetch of /.
  const refresh = await call({ path: '/', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
  assert.match(refresh.headers['set-cookie'], /^pb_token_/);
  assert.match((await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'], /^pb_token_/);
  // Another site’s request, even one the browser makes, doesn’t.
  const other = await call({ path: '/', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } });
  assert.equal(other.headers['set-cookie'], undefined);
});

test('#74: reads need no token, /mcp keeps its own session check, and other sites are still refused', async () => {
  const st = await call({ path: '/api/state' });
  assert.equal(st.status, 200);
  const mcp = await call({
    method: 'POST',
    path: '/mcp?session=se_none',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'show_block', arguments: {} } },
  });
  assert.equal(mcp.status, 200);
  assert.match(mcp.json.error.message, /Unknown Postbox session/);
  const cookie = await pageCookie();
  const cross = await call({ method: 'PUT', path: '/api/settings', body: { theme: 'dark' }, cookie, origin: 'https://example.com' });
  assert.equal(cross.status, 403);
  assert.match(cross.json.error, /other sites/);
});

test('#74: a message sent with the page’s token posts as the person; one without it posts nothing', async () => {
  const thread = Object.values(app.store.state.threads).find((t) => t.title === 'Corpus explorer');
  const before = app.store.items(thread.id).length;
  const refused = await call({ method: 'POST', path: `/api/threads/${thread.id}/messages`, body: { text: 'from curl' } });
  assert.equal(refused.status, 403);
  assert.equal(app.store.items(thread.id).length, before);
  const cookie = await pageCookie();
  const sent = await call({ method: 'POST', path: `/api/threads/${thread.id}/messages`, body: { text: 'from the page' }, cookie });
  assert.equal(sent.status, 201);
  assert.equal(app.store.items(thread.id).find((i) => i.kind === 'user')?.text, 'from the page');
  for (const se of app.rt.sessionsIn(thread.id)) app.rt.stop(se.id, { silent: true });
});
