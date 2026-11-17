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
