// No repaint takes focus away (design-597-release-1, F1; the integrator’s review of #597): with a control focused,
// each store event a repaint listens to (a session, a thread, a full load) leaves focus on that same node. One helper,
// run over every view that repaints, so a new view adds one line. Plus Edit’s Cancel and Save, and Escape in the editor.
import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {Map<string, () => void>} */
const releases = new Map();
let count = 0;
test.beforeAll(async () => {
  app = await startPostbox('queue-focus');
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

/** A conversation with one busy agent and two messages queued for it, open at 1280 px. */
async function room(page) {
  const n = ++count;
  const p = app.rt.createPersona({ handle: `focus${n}`, backend: 'claude-code' });
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Queue focus ${n}`, personaIds: [p.id] });
  const [se] = app.rt.sessionsIn(thread.id);
  app.rt.sendMessage(thread.id, { text: `@${se.handle} start the long job` });
  await expect.poll(() => releases.has(se.id)).toBe(true);
  app.rt.sendMessage(thread.id, { text: `@${se.handle} first follow-up` });
  app.rt.sendMessage(thread.id, { text: `@${se.handle} second follow-up` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  return { thread, se };
}
const mailButton = (page, se) =>
  page
    .locator('.agent-row')
    .filter({ hasText: `@${se.handle}` })
    .getByRole('button', { name: /queued for/ });

/** The store events a repaint listens to, each sent while something is focused. */
const pokes = {
  session: async (_page, { se }) => app.rt.updateSession(se.id, { focusProbe: Date.now() }),
  thread: async (_page, { thread }) => app.rt.putThread({ ...app.store.state.threads[thread.id] }),
  load: async (page) => page.evaluate(async () => (await import('/app/js/client.mjs')).client.emit({ type: 'load' })),
};

/** F1: focus the control, send each event, and check the focused node is still the same node. */
async function focusSurvives(page, r, control, label) {
  await control.focus();
  await control.evaluate((el) => {
    el.dataset.focusProbe = 'held';
  });
  for (const [kind, poke] of Object.entries(pokes)) {
    await poke(page, r);
    await synced(page, app);
    await settled(page);
    expect.soft(await page.evaluate(() => document.activeElement?.getAttribute('data-focus-probe')), `${label}: focus after a ${kind} event`).toBe('held');
  }
}

test('F1: every repainting view keeps focus on the same node through session, thread and load events', async ({ page }) => {
  const r = await room(page);
  await focusSurvives(page, r, page.locator('#composer-input'), 'the composer');
  await focusSurvives(page, r, page.locator('.composer .queue-waiting'), 'the waiting line');
  await focusSurvives(
    page,
    r,
    page
      .locator('.agent-row')
      .filter({ hasText: `@${r.se.handle}` })
      .locator('.agent-btn'),
    'the agent row',
  );
  await focusSurvives(page, r, mailButton(page, r.se), 'the mail button');
  await mailButton(page, r.se).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`queued for @${r.se.handle}`) });
  await focusSurvives(page, r, dialog.getByRole('button', { name: /^Send now: message 2 of 2/ }), 'the dialog’s second Send now');
});

test('F1: the thread panel’s head keeps focus through the same events', async ({ page }) => {
  const r = await room(page);
  const root = app.store.items(r.thread.id).find((i) => i.kind === 'user');
  const { threadId } = app.rt.startTopic(r.thread.id, root.id);
  // A fresh load, as the queue-bound panel cases do: a hash change alone can route before the new topic arrives.
  await page.goto(`${app.origin}/#/t/${r.thread.id}/side/${threadId}`);
  await page.reload();
  await synced(page, app);
  await expect(page.locator(`.sidepanel .transcript[data-thread="${threadId}"]`)).toBeVisible();
  await focusSurvives(page, r, page.locator('.sidepanel').getByRole('button', { name: 'Full screen' }), 'the panel’s full-screen button');
  await focusSurvives(page, r, page.locator('.sidepanel textarea'), 'the panel’s composer');
});

for (const action of ['Cancel', 'Save'])
  test(`F1: Edit, then ${action}, puts focus back on that message’s Edit`, async ({ page }) => {
    const r = await room(page);
    await mailButton(page, r.se).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(`queued for @${r.se.handle}`) });
    await dialog.getByRole('button', { name: /^Edit message 2 of 2/ }).click();
    await dialog.getByRole('textbox', { name: 'Edit the queued message' }).fill(`@${r.se.handle} second follow-up, edited`);
    await dialog.getByRole('button', { name: action, exact: true }).click();
    await expect(dialog.getByRole('button', { name: /^Edit message 2 of 2/ })).toBeFocused();
  });

test('Escape in the editor leaves the editor and keeps the draft; a second Escape closes the dialog', async ({ page }) => {
  const r = await room(page);
  await mailButton(page, r.se).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`queued for @${r.se.handle}`) });
  await dialog.getByRole('button', { name: /^Edit message 1 of 2/ }).click();
  const editor = dialog.getByRole('textbox', { name: 'Edit the queued message' });
  await editor.fill('A draft I mean to keep');
  await page.keyboard.press('Escape');
  await expect(dialog, 'the first Escape keeps the dialog').toBeVisible();
  await expect(editor).toHaveValue('A draft I mean to keep');
  await expect(dialog.getByRole('button', { name: 'Save', exact: true }), 'focus stays on the row').toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
