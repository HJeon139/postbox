// net.fetch against real sockets: a name that resolves to loopback is refused where the socket connects, and a local
// stand-in server, made public through the allow list, sees a GET with no cookies, a redirect comes back unfollowed, and
// a body past 1 MB is refused.

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { netFetch } from '../../server/net-fetch.mjs';

test('a name that isn’t “localhost” but resolves to loopback is refused after resolution, where the socket connects', async () => {
  await assert.rejects(netFetch({ url: 'http://localhost./' }), (e) => e.status === 403 && /private address/.test(e.message));
});

test('net.fetch GETs with no cookies, reads up to 1 MB, and gives back a redirect without following it', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null });
    if (req.url === '/moved') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/private' });
      return res.end();
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(1024 * 1024 + 1));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const host = `127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  process.env.POSTBOX_FETCH_ALLOW = host;
  t.after(() => delete process.env.POSTBOX_FETCH_ALLOW);
  assert.deepEqual(await netFetch({ url: `http://${host}/data` }), { status: 200, type: 'application/json', text: '{"ok":true}' });
  assert.deepEqual(seen.at(-1), { method: 'GET', cookie: null, authorization: null });
  const moved = await netFetch({ url: `http://${host}/moved` });
  assert.deepEqual([moved.status, moved.location], [302, 'http://127.0.0.1:1/private'], 'the redirect comes back, unfollowed');
  await assert.rejects(netFetch({ url: `http://${host}/big` }), (e) => e.status === 413);
});

/** A local stand-in site, made public through the allow list for the test: its host. @param {http.RequestListener} handler */
async function standIn(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const host = `127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  process.env.POSTBOX_FETCH_ALLOW = host;
  t.after(() => delete process.env.POSTBOX_FETCH_ALLOW);
  return host;
}

test('a site that sends a byte now and then is cut off at the deadline, with a 504', { timeout: 10_000 }, async (t) => {
  const host = await standIn(t, (_req, res) => {
    res.writeHead(200);
    const drip = setInterval(() => res.write('x'), 100);
    res.on('close', () => clearInterval(drip));
  });
  const started = Date.now();
  await assert.rejects(netFetch({ url: `http://${host}/slow` }, { ms: 600 }), (e) => e.status === 504);
  assert.ok(Date.now() - started < 2000, `gave up after ${Date.now() - started} ms`);
});

test('a site that never answers is a 504, not a 502', { timeout: 10_000 }, async (t) => {
  const host = await standIn(t, () => {});
  await assert.rejects(netFetch({ url: `http://${host}/hang` }, { ms: 300 }), (e) => e.status === 504 && /gave up/.test(e.message));
});

test('net.fetch goes direct, never through a proxy the environment sets, and sends it no credentials', async (t) => {
  const proxied = [];
  const proxy = http.createServer((req, res) => {
    proxied.push(req.headers['proxy-authorization'] ?? null);
    res.end('via the proxy');
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const global = http.globalAgent;
  // What NODE_USE_ENV_PROXY=1 with HTTP_PROXY set does to every request that takes node’s default agent.
  const proxyUrl = `http://user:secret@127.0.0.1:${/** @type {any} */ (proxy.address()).port}`;
  http.globalAgent = new http.Agent(/** @type {any} */ ({ proxyEnv: { HTTP_PROXY: proxyUrl } }));
  t.after(() => {
    http.globalAgent = global;
  });
  const host = await standIn(t, (_req, res) => res.end('direct'));
  assert.equal((await netFetch({ url: `http://${host}/` })).text, 'direct');
  await assert.rejects(netFetch({ url: 'http://localhost./admin' }), (e) => e.status === 403);
  assert.deepEqual(proxied, [], 'nothing reached the proxy');
});
