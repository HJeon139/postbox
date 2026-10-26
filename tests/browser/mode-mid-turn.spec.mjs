// A permission mode changed while an agent’s turn runs (#371, #381): where the backend can’t change a running turn, the
// turn keeps the mode it started with until it ends, and the quick panel says so, and that Stop applies the new one.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let room;
/** @type {any} */
let live;
/** Lets the held turn end. */
let release = () => {};
/** Lets the Agent SDK-like turn end. */
let releaseLive = () => {};

test.beforeAll(async () => {
  app = await startPostbox('mode-mid-turn');
  const { rt, store } = app;
  // A Codex-like backend: it has no setPermissionMode, so a running turn keeps its mode. Its turn holds until released.
  rt.adapters.register({
    name: 'codex',
    async folderFor() {
      return app.root;
    },
    async deliver(_session, _message, ctx) {
      ctx.status({ state: 'tool', currentStep: 'Running the tests' });
      await new Promise((r) => {
        release = () => r(undefined);
        ctx.signal.addEventListener('abort', () => r(undefined));
      });
    },
  });
  // An Agent SDK-like backend: its running turn takes a new mode at once (setPermissionMode).
  rt.adapters.register({
    name: 'agent-sdk',
    async folderFor() {
      return app.root;
    },
    async deliver(_session, _message, ctx) {
      ctx.control?.({ setPermissionMode: async () => true });
      ctx.status({ state: 'tool', currentStep: 'Writing the notes' });
      await new Promise((r) => {
        releaseLive = () => r(undefined);
        ctx.signal.addEventListener('abort', () => r(undefined));
      });
    },
  });
  store.emit('project', { id: 'pr_mode', name: 'Modes', folder: app.root });
  const p = rt.createPersona({ handle: 'coder', backend: 'codex', model: 'gpt-6-sol', permissionMode: 'auto', tools: ['shell'] });
  room = rt.createThread({ projectId: 'pr_mode', title: 'Modes', personaIds: [p.id] });
  rt.sendMessage(room.id, { text: '@coder run the tests' });
  const w = rt.createPersona({ handle: 'writer', backend: 'agent-sdk', permissionMode: 'auto', tools: ['shell'] });
  live = rt.createThread({ projectId: 'pr_mode', title: 'Live', personaIds: [w.id] });
  rt.sendMessage(live.id, { text: '@writer write the notes' });
});
test.afterAll(async () => {
  release();
  releaseLive();
  await app?.stop();
});
failOnPageErrors(test);

test('the quick panel says a running turn keeps its mode until it ends, and that Stop applies the new one now', async ({ page }) => {
  await expect.poll(() => app.rt.turns.size, { message: '@coder and @writer at work' }).toBe(2);
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await page.locator('.rail .agent-row .agent-btn', { hasText: '@coder' }).click();
  const panel = page.locator('.backdrop .dialog.quick');
  await panel
    .locator('[role=radiogroup][aria-label^="Permission mode"]')
    .getByRole('radio', { name: /^Run everything/ })
    .click();
  await expect(panel.locator('.perm-status')).toHaveText(
    'Permission mode: Run everything for @coder in every conversation, from their next turns. Its running turn here keeps the mode it started with until it ends: Stop it to apply this now.',
  );
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  // With no turn running, it says only when it applies.
  release();
  await expect.poll(() => app.rt.turns.size, { message: '@coder done' }).toBe(1);
  await panel
    .locator('[role=radiogroup][aria-label^="Permission mode"]')
    .getByRole('radio', { name: /^Ask me/ })
    .click();
  await expect(panel.locator('.perm-status')).toHaveText('Permission mode: Ask me for @coder in every conversation, from their next turns.');
});

test('/mode says a running turn its backend changes at once takes the new mode now', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${live.id}`);
  await synced(page, app);
  await page.locator('#composer-input').focus();
  await page.keyboard.type('/mo');
  await expect(page.locator('#slash-list')).toContainText('/mode');
  await page.keyboard.press('Enter');
  await page.locator('.dialog').getByRole('radiogroup', { name: 'Permission mode' }).getByRole('radio', { name: 'Accept edits', exact: true }).click();
  await expect(page.locator('.dialog .perm-status')).toContainText('@writer uses Accept edits, in every conversation, from now: its running turn changed too.');
});
