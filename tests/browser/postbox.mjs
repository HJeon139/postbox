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
 * A free port, picked at random below the ephemeral ranges: the system hands those out in order, so one picked there
 * could be given away before Postbox binds it.
 */
async function freePort() {
  for (let i = 0; i < 100; i++) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    if (await free(port)) return port;
  }
  throw new Error('Couldn’t find a free port for Postbox.');
}

/**
 * Starts a fresh Postbox for one spec file. stop() closes it and removes its data. Its temp folder is also the home
 * it reads Claude Code’s config from, so no spec reads the person’s own.
 * @param {string} name  a short name for its temp folder
 * @param {{ demo?: boolean, mockOnly?: boolean, prepare?: (root: string) => Promise<void>, server?: Parameters<typeof start>[0] }} [options]
 *   demo: false starts it as a fresh install, without the demo’s conversations; mockOnly: false lets it look for real
 *   backends, as POSTBOX_BACKENDS says; prepare writes what it should find in its home before it starts; server adds
 *   options of start() (server/index.mjs), such as a fake hosts manager and probes
 */
export async function startPostbox(name, { demo = true, mockOnly = true, prepare, server } = {}) {
  if (mockOnly) process.env.POSTBOX_BACKENDS = 'mock';
  const root = await mkdtemp(join(tmpdir(), `pb-spec-${name}-`));
  await prepare?.(root);
  // Another worker can bind the port between freePort() and start(): start() then closes what it opened and throws,
  // so try another port (#367).
  let app;
  for (let i = 0; !app; i++)
    app = await start({ ...server, port: await freePort(), dataDir: join(root, 'data'), fresh: true, demo, quiet: true, claudeHome: root }).catch((e) => {
      if (e?.code !== 'EADDRINUSE' || i >= 4) throw e;
    });
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
 * The width of the window the test set. Measure what fits a narrow window against it, not innerWidth: on a phone
 * (isMobile), a page that overflows widens innerWidth to fit, so nothing could stick out of that.
 * @param {import('@playwright/test').Page} page
 */
export const windowWidth = (page) => /** @type {{ width: number }} */ (page.viewportSize()).width;

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

/** @type {WeakMap<import('@playwright/test').Page, { pattern: RegExp, left: number }[]>} */
const allowed = new WeakMap();

/**
 * Lets a test’s page log an error the test causes on purpose, such as a request it expects the server to refuse: as
 * many times as the test says, and no more.
 * @param {import('@playwright/test').Page} page  @param {RegExp} pattern  @param {{ times?: number }} [options]
 */
export function allowPageError(page, pattern, { times = 1 } = {}) {
  allowed.set(page, [...(allowed.get(page) ?? []), { pattern, left: times }]);
}
/** Whether a console error is one the test allowed, using one of its allowed times. */
function expected(page, text) {
  const a = allowed.get(page)?.find((x) => x.left > 0 && x.pattern.test(text));
  if (a) a.left--;
  return !!a;
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
      if (m.type() === 'error' && !expected(page, m.text())) errors.push(`console.error: ${m.text()}`);
    });
  });
  test.afterEach(() => {
    expect(errors, 'the page threw no exceptions and logged no errors').toEqual([]);
  });
}

/** Until the browser has drawn two more frames. @param {import('@playwright/test').Page} page */
export const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/**
 * Waits until the page’s scroll positions and layout have held still for two frames. A spec that measures a position
 * measures once, after this, rather than polling the value it asserts, so a view that drifts and comes back fails (#298).
 * @param {import('@playwright/test').Page} page
 */
export async function settled(page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const snap = () =>
            JSON.stringify([
              scrollX,
              scrollY,
              innerWidth,
              innerHeight,
              document.scrollingElement?.scrollHeight,
              ...[...document.querySelectorAll('.sp-body, #main > *, .working, .jump')].map((n) => {
                const b = n.getBoundingClientRect();
                return [n.scrollTop, Math.round(b.top), Math.round(b.height)];
              }),
            ]);
          const before = snap();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return snap() === before;
        }),
      { message: 'the page to hold still for two frames' },
    )
    .toBe(true);
}

/**
 * Watches the page’s writes to the server (its POST requests) from now on, those to an address url matches. answered()
 * waits until at least one has been made and every one has been answered, so a test can then check what a refused one
 * would have shown. Name the writes the test makes: an app saving its state writes too, and may still be in flight.
 * @param {import('@playwright/test').Page} page  @param {RegExp} [url]
 */
export function watchWrites(page, url = /./) {
  const flying = new Set();
  let landed = 0;
  page.on('request', (r) => r.method() === 'POST' && url.test(new URL(r.url()).pathname) && flying.add(r));
  for (const ev of /** @type {const} */ (['requestfinished', 'requestfailed'])) page.on(ev, (r) => flying.delete(r) && landed++);
  return { answered: () => expect.poll(() => flying.size === 0 && landed > 0, { message: 'every write the page made answered' }).toBe(true) };
}

/**
 * Where focus is, as a short description: the focused element’s role or tag, and its accessible name (its label,
 * else its text), or “body”.
 * @param {import('@playwright/test').Page} page
 */
export const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    return `${a.getAttribute('role') ?? a.tagName.toLowerCase()}: ${(a.getAttribute('aria-label') ?? a.textContent?.trim().replace(/\s+/g, ' ') ?? '').slice(0, 80)}`;
  });

/**
 * Waits for focus to be on what that describes, a string or a pattern, and checks it’s still there two frames on, so
 * focus that lands and is lost on a repaint fails.
 * @param {import('@playwright/test').Page} page  @param {string | RegExp} want
 */
export async function focusIs(page, want) {
  const is = (f) => (typeof want === 'string' ? f === want : want.test(f));
  await expect.poll(async () => is(await focused(page)), { message: `focus on ${want}` }).toBe(true);
  await frames(page);
  const now = await focused(page);
  expect(is(now), `focus stayed on ${want}, and is on ${now}`).toBe(true);
}
