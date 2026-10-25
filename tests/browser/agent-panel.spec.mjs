// What an agent’s row in the Agents section says about its quick panel (#308, #317). aria-expanded follows whichever
// happened last, the panel opening or closing or the agent’s needs changing: absent while the row goes to the agent’s
// ask (it opens no dialog then), "true" while the panel is open, and "false" otherwise.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let thread;
/** @type {any} */
let zeta;

test.beforeAll(async () => {
  app = await startPostbox('agent-panel');
  const { rt, store } = app;
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(_session, _message, ctx) {
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_panel', name: 'Panel', folder: app.root });
  const persona = rt.createPersona({ handle: 'zeta', backend: 'claude-code', permissionMode: 'auto', tools: [] });
  thread = rt.createThread({ projectId: 'pr_panel', title: 'Panel', personaIds: [persona.id] });
  zeta = rt.sessionsIn(thread.id)[0];
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** Makes @zeta need you, or stop, as a turn’s end would, and waits for the page to hear it. */
async function needs(page, on) {
  app.rt.updateSession(zeta.id, on ? { state: 'needs', needs: { kind: 'block', itemId: 'ask-zeta', text: 'Which first?' } } : { state: 'idle', needs: null });
  await synced(page, app);
}
const row = (page) => page.locator(`#agent-row-${zeta.id}`);
/** What @zeta’s row says about its panel: [aria-haspopup, aria-expanded]. */
const says = (page) => row(page).evaluate((b) => [b.getAttribute('aria-haspopup'), b.getAttribute('aria-expanded')]);
const panel = (page) => page.locator('.backdrop .dialog.quick');

test.beforeEach(async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect(row(page)).toBeVisible();
});

test('an idle agent: its row opens a dialog, says so, and says whether it’s open', async ({ page }) => {
  await expect.poll(() => says(page)).toEqual(['dialog', 'false']);
  await row(page).click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => says(page), 'open').toEqual(['dialog', 'true']);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => says(page), 'closed').toEqual(['dialog', 'false']);
});

test('its panel open, the agent starts needing you, the panel closes: the row says no dialog, not a closed one', async ({ page }) => {
  await row(page).click();
  await expect(panel(page)).toBeVisible();
  try {
    await needs(page, true);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => says(page), 'the row goes to the ask, and opens no dialog').toEqual([null, null]);
  } finally {
    await needs(page, false);
  }
  await expect.poll(() => says(page), 'idle again').toEqual(['dialog', 'false']);
});

test('its panel open from the ⋯ while it needs you, the ask clears: the row says the panel is open until it closes', async ({ page }) => {
  try {
    await needs(page, true);
    await page.getByRole('button', { name: 'More for @zeta' }).click();
    await expect(panel(page)).toBeVisible();
    await needs(page, false);
    await expect.poll(() => says(page), 'the ask cleared with the panel open').toEqual(['dialog', 'true']);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => says(page), 'and closed').toEqual(['dialog', 'false']);
  } finally {
    await needs(page, false);
  }
});
