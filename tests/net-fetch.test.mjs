// net.fetch: public data for an agent app, fetched by Postbox’s server. It refuses this computer and the local
// network, by name and after DNS resolution; credentials in the URL; schemes but http and https; and it never follows a
// redirect, so one can’t lead to a private address. What opens a socket is in tests/integration/net-fetch.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { netFetch } from '../server/net-fetch.mjs';

test('net.fetch refuses bracketed IPv6 forms of loopback, metadata and the local network before connecting', async () => {
  for (const url of [
    'http://[::ffff:127.0.0.1]:4517/',
    'http://[::ffff:7f00:1]:4517/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]:4517/',
    'http://[::ffff:a9fe:a9fe]/latest/',
    'http://[::ffff:192.168.1.1]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
  ])
    await assert.rejects(netFetch({ url }), (e) => e.status === 403, url);
});

test('net.fetch refuses this computer and the local network, by name and by address', async () => {
  for (const url of ['http://localhost:4517/api/state', 'http://192.168.3.20/', 'http://[::1]:80/', 'http://169.254.169.254/latest/', 'http://10.0.0.1/'])
    await assert.rejects(netFetch({ url }), (e) => e.status === 403, url);
});

test('net.fetch refuses credentials in the URL and schemes other than http and https', async () => {
  await assert.rejects(netFetch({ url: 'https://user:pw@example.com/' }), (e) => e.status === 400);
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'data:text/plain,hi', 'not a url'])
    await assert.rejects(netFetch({ url }), (e) => e.status === 400, url);
});
