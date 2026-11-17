// net.fetch: public data for an agent app, fetched by Postbox’s server. It refuses this computer and the local
// network, by name and after DNS resolution; credentials in the URL; schemes but http and https; and it never follows a
// redirect, so one can’t lead to a private address. What opens a socket is in tests/integration/net-fetch.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { netFetch, privateAddress } from '../server/net-fetch.mjs';

test('private, loopback, link-local and other non-public addresses are recognized', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.3.20',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:192.168.1.1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
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
