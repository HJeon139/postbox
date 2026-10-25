// What every browser spec shares (#303): a Postbox of its own, and a way to wait for the page to hear the server.
// Each spec file starts one in its beforeAll, on a fresh data folder in the temp directory and a free port, with
// scripted agents only (no real turns). It runs in the Playwright worker’s process, so a spec reaches its runtime
// and store directly, as the checks in tools/ did.

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { start } from '../../server/index.mjs';

/** Whether nothing listens on a port of 127.0.0.1. */
const free = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });

/**
 * A free port, picked at random below the ephemeral ranges, as tools/check-all.mjs picks them: the system hands those
 * out in order, so one picked there could be given away before Postbox binds it.
 */
async function freePort() {
  for (let i = 0; i < 100; i++) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    if (await free(port)) return port;
  }
  throw new Error('Couldn’t find a free port for Postbox.');
}

/**
 * Starts a fresh Postbox for one spec file. stop() closes it and removes its data.
 * @param {string} name  a short name for its temp folder
 */
export async function startPostbox(name) {
  process.env.POSTBOX_BACKENDS = 'mock';
  const root = await mkdtemp(join(tmpdir(), `pb-spec-${name}-`));
  const app = await start({ port: await freePort(), dataDir: join(root, 'data'), fresh: true, demo: true, quiet: true });
  return {
    ...app,
    root,
    async stop() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Waits until the page has applied the server’s events up to its store’s seq now. A change made on the server
 * reaches the page over its event stream, which nothing orders with the test’s next step (POSTBOX_STREAM_LAG shows it).
 * @param {import('@playwright/test').Page} page  @param {{ store: { state: { seq: number } } }} app
 */
export async function synced(page, app) {
  const seq = app.store.state.seq;
  await expect
    .poll(() => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.seq)), { message: `the page to hear event ${seq}` })
    .toBeGreaterThanOrEqual(seq);
}

/**
 * Fails each test whose page threw an exception, or logged an error to the console, after the test's own steps.
 * @param {import('@playwright/test').TestType<any, any>} test
 */
export function failOnPageErrors(test) {
  /** @type {string[]} */
  let errors = [];
  test.beforeEach(({ page }) => {
    errors = [];
    page.on('pageerror', (e) => errors.push(`exception: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });
  });
  test.afterEach(() => {
    expect(errors, 'the page threw no exceptions and logged no errors').toEqual([]);
  });
}
