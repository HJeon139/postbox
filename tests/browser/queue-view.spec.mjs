// The queue view’s rules beyond the bound (#427; the design note design-427-1, V1, V2, V5 and V6): offline rows are
// capped, a waiting line near the composer keeps the queue visible, Remove buttons have distinct names, and the
// agent’s dialog is modal, labelled, and gives focus back somewhere that exists.
import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {Map<string, () => void>} */
const releases = new Map();
let count = 0;
test.beforeAll(async () => {
  app = await startPostbox('queue-view');
  app.rt.adapters.register({
    name: 'claude-code',
    folderFor: async () => app.root,
    async deliver(session, _message, ctx) {
      if (releases.has(session.id)) return ctx.text('Answered.');
      await new Promise((resolve) => {
        releases.set(session.id, () => resolve(null));
        ctx.signal.addEventListener('abort', resolve, { once: true });
      });
      if (!ctx.signal.aborted) ctx.text('Done with the long job.');
    },
  });
});
test.afterAll(async () => {
  for (const release of releases.values()) release();
  await app?.stop();
});
failOnPageErrors(test);

/** A conversation with `agents` busy agents, open in the page. */
async function busyRoom(page, agents = 1) {
  const n = ++count;
  const personas = Array.from({ length: agents }, (_, i) => app.rt.createPersona({ handle: `mailee${i + 1}-${n}`, backend: 'claude-code' }));
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Queue view ${n}`, personaIds: personas.map((p) => p.id) });
  const sessions = app.rt.sessionsIn(thread.id);
  for (const se of sessions) app.rt.sendMessage(thread.id, { text: `@${se.handle} start the long job` });
  await expect.poll(() => sessions.every((se) => releases.has(se.id))).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  return { thread, sessions };
}
const openMail = async (page, se) => {
  await page
    .locator('.agent-row')
    .filter({ hasText: `@${se.handle}` })
    .getByRole('button', { name: /queued for/ })
    .click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`queued for @${se.handle}`) });
  await expect(dialog).toBeVisible();
  return dialog;
};

test('V1: ten messages saved offline show two rows and a count of the rest', async ({ page }) => {
  await page.goto(app.origin);
  const shown = await page.evaluate(async () => {
    const { paintOfflineQueue } = await import('/app/js/agent-queue.mjs');
    const box = document.createElement('div');
    paintOfflineQueue(
      box,
      Array.from({ length: 10 }, (_, i) => ({ threadId: 't1', text: `Saved offline ${i + 1}`, attachments: [] })),
    );
    return { rows: box.querySelectorAll('.queued').length, text: box.textContent };
  });
  expect(shown.rows, 'rows, the count line included').toBeLessThanOrEqual(3);
  expect(shown.text).toContain('and 8 more waiting for the connection');
});

test('V2: a waiting line near the composer counts the queue and opens it', async ({ page }) => {
  const { thread, sessions } = await busyRoom(page, 2);
  app.rt.sendMessage(thread.id, { text: `@${sessions[0].handle} one` });
  app.rt.sendMessage(thread.id, { text: `@${sessions[0].handle} two` });
  app.rt.sendMessage(thread.id, { text: `@${sessions[1].handle} three` });
  await synced(page, app);
  const line = page.locator('.composer').getByRole('button', { name: '3 waiting for 2 agents' });
  await expect(line).toBeVisible();
  await line.click();
  await page.getByRole('menuitem', { name: `2 messages queued for @${sessions[0].handle}` }).click();
  await expect(page.getByRole('dialog', { name: `2 queued for @${sessions[0].handle}` })).toBeVisible();
});

test('V2: with one agent waiting, the line opens its dialog directly', async ({ page }) => {
  const { thread, sessions } = await busyRoom(page, 1);
  app.rt.sendMessage(thread.id, { text: `@${sessions[0].handle} only one` });
  await synced(page, app);
  await page.locator('.composer').getByRole('button', { name: '1 waiting for 1 agent' }).click();
  await expect(page.getByRole('dialog', { name: `1 queued for @${sessions[0].handle}` })).toBeVisible();
});

test('V5: two identical queued messages have Send now, Edit and Remove buttons with different names', async ({ page }) => {
  const { thread, sessions } = await busyRoom(page);
  for (let i = 0; i < 2; i++) app.rt.sendMessage(thread.id, { text: `@${sessions[0].handle} the same words` });
  await synced(page, app);
  const dialog = await openMail(page, sessions[0]);
  for (const action of ['Send now', 'Edit', 'Remove']) {
    const names = await dialog
      .locator('.agent-queue-row button')
      .evaluateAll((els, a) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? '').filter((n) => n.startsWith(a)), action);
    expect(names, `${action} buttons`).toHaveLength(2);
    expect(new Set(names).size, `distinct ${action} names: ${names.join(' | ')}`).toBe(2);
    for (const n of names) expect(n.startsWith(action), `the name begins with the visible text “${action}”`).toBe(true);
  }
});

test('offline to queue: a message saved offline leaves the composer’s offline rows and joins the queue on reconnect', async ({ page }) => {
  const { sessions } = await busyRoom(page);
  allowPageError(page, /ERR_INTERNET_DISCONNECTED/);
  await page.context().setOffline(true);
  await page.locator('#composer-input').fill(`@${sessions[0].handle} written while offline`);
  await page.locator('#composer-input').press('Enter');
  await expect(page.locator('.composer .queued').filter({ hasText: 'written while offline' })).toBeVisible();
  await page.context().setOffline(false);
  // The stream reconnects as EventSource's own retry does; headless Chromium keeps an open stream through setOffline.
  await page.evaluate(async () => (await import('/app/js/client.mjs')).connect());
  await synced(page, app);
  await expect(page.locator('.composer .queued')).toHaveCount(0);
  await expect(page.locator('.composer').getByRole('button', { name: '1 waiting for 1 agent' })).toBeVisible();
});

test('V6: the dialog keeps Tab inside, closes on Escape, and gives focus back to the mail button', async ({ page }) => {
  const { thread, sessions } = await busyRoom(page);
  app.rt.sendMessage(thread.id, { text: `@${sessions[0].handle} trap me` });
  await synced(page, app);
  const dialog = await openMail(page, sessions[0]);
  await expect(dialog.getByRole('button', { name: /^Send now: message 1 of 1/ }), 'focus starts on the first row’s first action').toBeFocused();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `Tab ${i + 1} stays in the dialog`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(
    page
      .locator('.agent-row')
      .filter({ hasText: `@${sessions[0].handle}` })
      .getByRole('button', { name: /queued for/ }),
  ).toBeFocused();
});

test('V6: when the agent leaves with its dialog open, the dialog closes and focus goes to the composer', async ({ page }) => {
  const { thread, sessions } = await busyRoom(page);
  app.rt.sendMessage(thread.id, { text: `@${sessions[0].handle} about to go` });
  await synced(page, app);
  const dialog = await openMail(page, sessions[0]);
  app.rt.deleteSession(sessions[0].id);
  await synced(page, app);
  await settled(page);
  await expect(dialog).toBeHidden();
  await expect(page.locator('#composer-input')).toBeFocused();
  // Its queued message isn’t lost: the queue posts it to the conversation, waking no one (server/message-queue.mjs).
  await expect(page.locator('#main .item').filter({ hasText: 'about to go' })).toBeVisible();
});

test('when every message is delivered with the dialog open, it closes and focus goes to the composer, not a hidden button', async ({ page }) => {
  const { thread, sessions } = await busyRoom(page);
  app.rt.sendMessage(thread.id, { text: `@${sessions[0].handle} delivered while you look` });
  await synced(page, app);
  const dialog = await openMail(page, sessions[0]);
  releases.get(sessions[0].id)();
  await synced(page, app);
  await expect(dialog).toBeHidden();
  await expect(page.locator('#composer-input')).toBeFocused();
});
