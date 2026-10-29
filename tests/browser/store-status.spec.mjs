// The store’s status line (#508’s requirements, ST-3; design 6.6, decision 7), with a real Postbox whose Redis child the
// spec stops under it:
// - while the store can’t be written, one line at the window’s bottom names the cause in plain words, with Retry; the
//   page stays readable (nothing covers the conversation), and a message you send is refused, saying why;
// - Retry starts the store again, and the line goes;
// - a turn running when Redis is killed stops, and once the store is back its reply says the store stopped it.
// Redis is kept from starting again by moving its build away (cause binary-missing), so the line holds still to be
// checked; putting the build back is what Retry then finds.

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { onDisk } from '../redis-on-disk.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('store-status', { demo: false });
  app.store.emit('project', { id: 'pr_store', name: 'Store', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** Kills the store’s Redis and keeps it from starting again; returns how to let it start. */
async function stopRedis() {
  const sup = /** @type {any} */ (app.store).redis.sup;
  const home = sup.home;
  await app.store.flush();
  await onDisk(app.store);
  sup.home = join(app.root, 'no-redis-here');
  sup.child.kill('SIGKILL');
  await expect.poll(() => /** @type {any} */ (app.store.status).cause, { message: 'the store to be down for good' }).toBe('binary-missing');
  return () => {
    sup.home = home;
  };
}

/** A conversation with one agent of its own. @param {string} handle */
function conversation(handle) {
  const p = app.rt.createPersona({ handle });
  const t = app.rt.createThread({ projectId: 'pr_store', title: `With @${handle}`, personaIds: [p.id] });
  return { t, se: app.rt.sessionsIn(t.id)[0] };
}

test('ST-3: with the store down, the status line names the cause with Retry, the page reads, and Retry brings it back', async ({ page }) => {
  const { t } = conversation('reader');
  app.rt.addItem(t.id, { kind: 'user', text: 'An earlier message' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const line = page.getByRole('status').filter({ hasText: 'can’t save changes' });
  await expect(line).toBeHidden();
  const back = await stopRedis();
  await expect(line).toBeVisible();
  await expect.soft(line).toContainText('its store’s Redis is missing');
  await expect.soft(line).toContainText('Agents don’t start new turns until then');
  const retry = line.getByRole('button', { name: 'Retry' });
  await expect.soft(retry).toBeVisible();
  // Readable: the conversation is there, and nothing covers it.
  await expect.soft(page.getByText('An earlier message')).toBeVisible();
  await expect.soft(page.locator('.backdrop')).toHaveCount(0);
  // A message you send is refused, and says why.
  allowPageError(page, /503/);
  const box = page.getByRole('textbox', { name: /message/i });
  await box.fill('Are you there?');
  await box.press('Enter');
  await expect.soft(page.getByText('Your message didn’t send')).toBeVisible();
  await expect.soft(page.getByText(/Postbox can’t save changes right now, so it didn’t make this one/)).toBeVisible();
  // Retry, with Redis’s build back: the store starts, reads back, and the line goes.
  back();
  await retry.click();
  await expect(line).toBeHidden({ timeout: 15_000 });
  expect(app.store.writable).toBe(true);
});

test('ST-3: a turn running when Redis is killed stops, and its reply says the store stopped it', async ({ page }) => {
  const { t, se } = conversation('runner');
  /** @type {AbortSignal | null} */
  let signal = null;
  app.rt.adapters.register({
    name: 'mock',
    async deliver(_s, _m, /** @type {any} */ ctx) {
      signal = ctx.signal;
      ctx.text('Working on it');
      await new Promise((ok) => ctx.signal.addEventListener('abort', ok, { once: true }));
    },
  });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const box = page.getByRole('textbox', { name: /message/i });
  await box.fill('Build it');
  await box.press('Enter');
  await expect(page.getByText('Working on it')).toBeVisible();
  const back = await stopRedis();
  const line = page.getByRole('status').filter({ hasText: 'can’t save changes' });
  await expect(line).toBeVisible();
  await expect.poll(() => /** @type {any} */ (signal)?.aborted, { message: 'the agent to be told to stop' }).toBe(true);
  expect(app.rt.turns.has(se.id)).toBe(false);
  back();
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect(line).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(/Stopped at .+: Postbox couldn’t save changes/)).toBeVisible();
});
