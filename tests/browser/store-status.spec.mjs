// The store’s status line (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants, I2; T-14), with a real
// Postbox whose store the spec closes under it, as a failed write would:
// - while the store can’t be written, one line at the window’s bottom names the cause in plain words, with Retry; the
//   page stays readable (nothing covers the conversation), and a message you send is refused, saying why;
// - Retry reloads the store and the line goes once writes reopen;
// - a turn running when the write fails stops, and once the store is back its reply says the store stopped it;
// - a store that never fails shows no line (the negative control).

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('store-status', { demo: false });
  app.store.emit('project', { id: 'pr_store', name: 'Store', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const eio = () => Object.assign(new Error('disk sync refused'), { code: 'EIO' });

/** A conversation with one agent of its own. @param {string} handle */
function conversation(handle) {
  const p = app.rt.createPersona({ handle });
  const t = app.rt.createThread({ projectId: 'pr_store', title: `With @${handle}`, personaIds: [p.id] });
  return { t, se: app.rt.sessionsIn(t.id)[0] };
}

test('ST-3: with the store closed, the status line names the cause with Retry, the page reads, and Retry brings it back', async ({ page }) => {
  const { t } = conversation('reader');
  app.rt.addItem(t.id, { kind: 'user', text: 'An earlier message' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const line = page.getByRole('status').filter({ hasText: 'can’t save changes' });
  await expect(line).toBeHidden();
  await app.store.flush();
  app.store.fail(eio());
  await expect(line).toBeVisible();
  await expect.soft(line).toContainText('the disk reported an error');
  await expect.soft(line).toContainText('Agents stopped and don’t start new turns until then');
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
  await expect.soft(page.getByText(/can’t write its event log/).first()).toBeVisible();
  // Retry: the store reloads its folder, writes reopen, and the line goes.
  await retry.click();
  await expect(line).toBeHidden({ timeout: 15_000 });
  expect(app.store.writable).toBe(true);
  await synced(page, app);
  await expect(page.getByText('An earlier message')).toBeVisible();
});

test('ST-3: a turn running when the write fails stops, and after Retry its reply says the store stopped it', async ({ page }) => {
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
  await app.store.flush();
  app.store.fail(eio());
  const line = page.getByRole('status').filter({ hasText: 'can’t save changes' });
  await expect(line).toBeVisible();
  await expect.poll(() => /** @type {any} */ (signal)?.aborted, { message: 'the agent to be told to stop' }).toBe(true);
  expect(app.rt.turns.has(se.id)).toBe(false);
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect(line).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(/Postbox couldn’t save changes/)).toBeVisible();
});

test('a store that never fails shows no status line', async ({ page }) => {
  const { t } = conversation('quiet');
  app.rt.addItem(t.id, { kind: 'user', text: 'All is well' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.getByText('All is well')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'save changes' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains('store-down'))).toBe(false);
});
