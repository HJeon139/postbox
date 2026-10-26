// A port taken between picking it and binding it (#367): start() throws EADDRINUSE having closed what it opened, so
// startPostbox() can try another port, and a later start on the same data folder works.

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { start } from '../../server/index.mjs';

/** The timers and sockets this process holds, by kind. */
const held = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout' || r === 'TCPServerWrap').length;

test('#367 start() on a taken port throws EADDRINUSE and leaves nothing running, and the next start works', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-spec-start-port-'));
  const other = createServer();
  await new Promise((ok) => other.listen(0, '127.0.0.1', ok));
  const taken = /** @type {import('node:net').AddressInfo} */ (other.address()).port;
  try {
    const before = held();
    const options = { dataDir: join(root, 'data'), fresh: true, demo: true, quiet: true, claudeHome: root };
    await expect(start({ ...options, port: taken })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(held(), 'no timer or server left from the failed start').toBeLessThanOrEqual(before);
    const app = await start({ ...options, port: 0 });
    await app.close();
  } finally {
    other.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('#367 the startup error handler is gone after a successful bind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-spec-start-listener-'));
  const app = await start({ port: 0, dataDir: join(root, 'data'), fresh: true, demo: true, quiet: true, claudeHome: root });
  try {
    app.server.once('error', () => {});
    app.server.emit('error', Object.assign(new Error('later server error'), { code: 'EIO' }));
    expect(app.server.listening).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
