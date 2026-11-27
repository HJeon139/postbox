// #1748: an agent shows a form and keeps working in the same turn. On 25 Nov the sidebar said “1 open form” while the
// top bar said “Nothing needs you” for over an hour, until the turn ended. Now the form is the agent's need from when
// it's shown: the top bar counts it at once, the sidebar's open-form button goes (the form is the need), and the ring
// doesn't pulse, since the agent is still working. Answering it mid-turn clears the count.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
let se;
/** Lets @alpha's held turn end. */
let release = () => {};

const form = {
  id: 'mid-window',
  type: 'form',
  version: 1,
  title: 'Which window should I compare?',
  fallback: 'Which window should I compare?',
  fields: [{ id: 'w', label: 'Window', kind: 'text' }],
};

test.beforeAll(async () => {
  app = await startPostbox('needs-mid-turn');
  const { rt, store } = app;
  // @alpha shows the form on its turn, then keeps working until the test lets it go.
  arrange.withAdapter(rt, {
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(_session, _message, ctx) {
      ctx.text('Looking at the account.');
      ctx.tools.show_block({ block: form });
      ctx.text('Reading the last 90 days while you choose.');
      await new Promise((res) => {
        release = res;
      });
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_mid', name: 'Mid-turn', folder: app.root });
  const alpha = rt.createPersona({ handle: 'alpha', backend: 'claude-code', permissionMode: 'auto', tools: [] }).id;
  thread = rt.createThread({ projectId: 'pr_mid', title: 'Mid-turn form', personaIds: [alpha] });
  se = Object.values(store.state.sessions).find((x) => x.handle === 'alpha');
});
test.afterAll(async () => {
  release();
  await app?.stop();
});
failOnPageErrors(test);

test('#1748 a form shown mid-turn is counted at once, without a pulse, and the sidebar stops calling it open', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const next = page.locator('#next-needs');
  await expect(next, 'nothing needs you before the turn').toBeDisabled();

  app.rt.sendMessage(thread.id, { text: '@alpha which window should we compare?' });
  await expect(page.getByText('Which window should I compare?').first()).toBeVisible();
  await expect.poll(() => arrange.liveTurns(app.rt), { message: 'the turn is still running' }).toBe(1);

  // The top bar counts it while the turn runs on.
  await expect(next, 'the top bar counts the form').toBeEnabled();
  await expect(next).toContainText('Next that needs you');
  // The form is the need, so the agent's row has no “1 open form” button beside it.
  await expect(page.locator(`[data-open-asks="${se.id}"]`).first(), 'no open-form button: the form is the need').toBeHidden();
  // The agent is still working, so its ring doesn't pulse.
  await expect(page.locator('.rail pb-ring[name="alpha"]').first(), 'the ring shows work, not a need').not.toHaveAttribute('state', 'needs');

  // Answering it mid-turn clears the count, with the turn still running.
  await page.getByRole('textbox', { name: 'Window' }).fill('30 days');
  await page.getByRole('button', { name: 'Send form' }).click();
  await expect(next, 'answered: nothing needs you').toBeDisabled();
  expect(arrange.liveTurns(app.rt), 'and the turn runs on').toBe(1);
  release();
});
