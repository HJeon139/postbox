// The store’s Redis is private (#508’s requirements, 4.3, “Store security”). Its real server is probed in
// tests/process/redis-security.test.mjs; these check, under the guard, what the rest of Postbox can see of it.

import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { open, raw, tmp } from './store-fixture.mjs';

test('SR-1: the store connects on its socket, and the guard lets nothing reach 127.0.0.1 while it runs', async () => {
  const s = await open(await tmp());
  const c = await raw(s);
  assert.equal(await c.call('PING'), 'PONG');
  c.close();
  for (const port of [6379, 0]) assert.throws(() => net.connect({ port, host: '127.0.0.1' }), /network connection/);
  assert.throws(() => net.connect({ path: '/tmp/some-other.sock' }), /network connection/);
});
