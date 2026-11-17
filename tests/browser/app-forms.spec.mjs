// #1476: a form in an agent app fires its submit event, for the app’s script to handle, and still goes nowhere. Without
// allow-forms in the app page’s sandbox, a sandboxed page never runs a form’s submission, its submit event included.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { clickApp, frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// Its submit button is big and at the top, where clickApp clicks. The handler counts submits in saved state.
const FORM = `<main style="padding:12px">
<form id="f"><button class="btn" type="submit" style="display:block;width:100%;height:120px">Save</button>
<label>Name <input id="n" value="Ada"></label></form>
</main>
<script>
let n = 0;
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  n++;
  postbox.saveState({ submits: n, name: document.getElementById('n').value });
});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-forms');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#1476 a form in an app submits to its own script on a click and on Enter, and goes nowhere', async ({ page }) => {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Form', personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `form-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title: 'Form', code: FORM, permissions: [] });
  await expect(frameOf(page, 'Form'), 'the app to load').toHaveAttribute('data-sized', '1');
  const state = () => rt.store.state.apps[id]?.state ?? {};
  const src = await frameOf(page, 'Form').getAttribute('src');

  await clickApp(page, 'Form');
  await expect.poll(() => state().submits, { message: 'the click’s submit reached the app’s script' }).toBe(1);

  await page.frameLocator('iframe.app-iframe[title="Form"]').locator('#n').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state().submits, { message: 'Enter in its field submitted too' }).toBe(2);
  expect(state().name).toBe('Ada');

  // form-action 'none' keeps a submission from going anywhere: the frame is still the app’s page.
  await expect(frameOf(page, 'Form')).toHaveAttribute('src', src);
  expect(await page.frameLocator('iframe.app-iframe[title="Form"]').locator('#f').count()).toBe(1);
});
