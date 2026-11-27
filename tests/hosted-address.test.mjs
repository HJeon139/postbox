// The address a hosted Postbox answers (designs/architecture/hosted.md, “The address it answers”): its one public
// origin in place of 127.0.0.1, with the load balancer’s health check the one route that answers any `Host` and no
// sign-in. A Postbox started without a public origin answers as it always has. Through the router with fake requests;
// nothing listens.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { start } from '../server/index.mjs';
import { NOW, publicPem, SETTINGS, tokenFor } from './alb-fixture.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

const PORT = 4476;
const ORIGIN = 'https://postbox.example.com';
const PUBLIC = 'postbox.example.com';
const LOOPBACK = `127.0.0.1:${PORT}`;
/** @type {any} */
let hosted;
/** @type {any} */
let local;
before(async () => {
  const dir = tempDir('pb-address-');
  const signIn = { settings: SETTINGS, get: async () => publicPem, now: () => NOW };
  hosted = await start({
    port: PORT,
    dataDir: dir,
    fresh: true,
    demo: true,
    quiet: true,
    claudeHome: dir,
    listen: false,
    host: '0.0.0.0',
    publicOrigin: ORIGIN,
    signIn,
  });
  const dir2 = tempDir('pb-address-local-');
  local = await start({ port: PORT + 1, dataDir: dir2, fresh: true, demo: true, quiet: true, claudeHome: dir2, listen: false });
});
after(async () => {
  await hosted.close();
  await local.close();
});

const signed = { 'x-amzn-oidc-data': tokenFor() };
const ask = (/** @type {any} */ r) => fakeRequest(hosted.handle, { host: PUBLIC, ...r, headers: { ...signed, ...r.headers } });
const askLocal = (/** @type {any} */ r) => fakeRequest(local.handle, { host: `127.0.0.1:${PORT + 1}`, ...r });

test('it answers its public origin, and the page is built from it', async () => {
  const state = await ask({ path: '/api/state' });
  assert.deepEqual([state.status, state.json.config.origin], [200, ORIGIN]);
  assert.equal(hosted.origin, ORIGIN);
});

test('a request addressed to anything else is refused, loopback and the container’s own address included', async () => {
  for (const host of [LOOPBACK, `localhost:${PORT}`, `10.0.1.23:${PORT}`, 'postbox.example.com.evil.example', `${PUBLIC}:${PORT}`, '']) {
    const answer = await ask({ path: '/api/state', host });
    assert.deepEqual([host, answer.status, answer.json.error], [host, 421, 'This Postbox only answers requests addressed to postbox.example.com.']);
  }
});

test('a write is taken from its own page and refused from another site, a loopback page among them', async () => {
  const cookie = (await ask({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  const put = (/** @type {string} */ origin) => ask({ method: 'PUT', path: '/api/settings', body: { theme: 'dark' }, origin, headers: { cookie } });
  assert.equal((await put(ORIGIN)).status, 200);
  for (const origin of [`http://${LOOPBACK}`, 'https://other.example', 'http://postbox.example.com'])
    assert.deepEqual([origin, (await put(origin)).status], [origin, 403]);
});

test('the page’s token cookie is sent only over TLS when hosted, and as it always was on your own computer', async () => {
  assert.match((await ask({ path: '/', headers: NAVIGATION })).headers['set-cookie'], /; HttpOnly; SameSite=Strict; Path=\/; Secure$/);
  assert.match((await askLocal({ path: '/', headers: NAVIGATION })).headers['set-cookie'], /; HttpOnly; SameSite=Strict; Path=\/$/);
});

test('the health check answers GET and HEAD with one fixed body, for any Host and with no sign-in', async () => {
  for (const host of ['10.0.1.23:8080', PUBLIC, LOOPBACK, ''])
    for (const method of ['GET', 'HEAD']) {
      const answer = await fakeRequest(hosted.handle, { method, path: '/health', host });
      assert.deepEqual([host, method, answer.status, answer.text], [host, method, 200, 'ok\n']);
    }
  // The same while the store can’t be written: it says only that something answers here.
  hosted.store.writable = false;
  try {
    assert.equal((await fakeRequest(hosted.handle, { path: '/health', host: '10.0.1.23:8080' })).text, 'ok\n');
  } finally {
    hosted.store.writable = true;
  }
});

test('the health check is that one path and those two methods: anything else is refused like any request', async () => {
  const bare = (/** @type {any} */ r) => fakeRequest(hosted.handle, { host: '10.0.1.23:8080', ...r });
  assert.equal((await bare({ method: 'POST', path: '/health' })).status, 421);
  for (const path of ['/health/', '/healthz', '/health/x', '/Health', '/api/state']) assert.deepEqual([path, (await bare({ path })).status], [path, 421]);
  // Addressed rightly and not signed in, a path beside it gets what every route does.
  assert.equal((await fakeRequest(hosted.handle, { path: '/health/', host: PUBLIC })).status, 401);
});

test('on your own computer there is no health check: the path is nothing, and another Host is refused as before', async () => {
  assert.equal((await askLocal({ path: '/health' })).status, 404);
  const other = await askLocal({ path: '/health', host: '10.0.1.23:8080' });
  assert.deepEqual([other.status, other.json.error], [421, 'Postbox only answers requests addressed to 127.0.0.1 or localhost.']);
  assert.equal((await askLocal({ path: '/api/state', host: PUBLIC })).status, 421);
});

test('an app’s sandbox may be framed by the public origin’s page, and locally by the page the request came to', async () => {
  const policy = (/** @type {any} */ answer) => /frame-ancestors ([^;]+)/.exec(answer.headers['content-security-policy'])?.[1];
  assert.equal(policy(await ask({ path: '/sandbox/mermaid' })), ORIGIN);
  assert.equal(policy(await askLocal({ path: '/sandbox/mermaid' })), `http://127.0.0.1:${PORT + 1}`);
  assert.equal(policy(await askLocal({ path: '/sandbox/mermaid', host: `localhost:${PORT + 1}` })), `http://localhost:${PORT + 1}`);
});

test('! commands are refused on a hosted Postbox, from every address, loopback included', async () => {
  const cookie = (await ask({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  const room = Object.keys(hosted.rt.s.threads)[0];
  for (const remoteAddress of ['127.0.0.1', '10.0.1.9']) {
    const answer = await ask({
      method: 'POST',
      path: `/api/threads/${room}/shell`,
      body: { command: 'id' },
      origin: ORIGIN,
      remoteAddress,
      headers: { cookie },
    });
    assert.deepEqual([answer.status, /listening on 0\.0\.0\.0/.test(answer.json.error)], [403, true]);
  }
});
