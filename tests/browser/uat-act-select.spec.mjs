// The UAT driver’s `act` fills a form’s select field by the option whose text holds the tester’s value (#1781). With
// no such option it left the field as it was, raised nothing, and the step passed, so the form’s default read as the
// tester’s pick. It now fails the step, saying which option it couldn’t find, as a choice’s missing option does. It
// drives the runner’s own driver against this page, through a stand-in for tools/browser.mjs’s page.

import { expect, test } from '@playwright/test';
import { driver } from '../../tools/uat/driver.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { runnerPage } from './runner-page.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('uat-act-select');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const FORM = {
  id: 'print-run',
  type: 'form',
  version: 1,
  title: 'The print run',
  fallback: 'What size, and how many copies?',
  fields: [
    {
      id: 'size',
      label: 'Size',
      kind: 'select',
      options: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large' },
      ],
      default: 'small',
    },
  ],
};

/** A room with @researcher’s form, open in the page; returns the form’s item and the select. */
async function formIn(page, title) {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title, personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  const form = arrange.post(rt, t.id, { kind: 'block', sessionId: se.id, handle: 'researcher', valid: true, block: FORM });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const select = page.locator(`[data-key="${form.id}"] select`);
  await expect(select).toHaveValue('small');
  return { form, select };
}

test('#1781 a select with no option the tester named fails the step and stays as it was', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the UAT driver works the page through Chromium’s DevTools protocol');
  const { form, select } = await formIn(page, 'No such size');
  const act = driver(await runnerPage(page)).act(form.id, { fills: [{ field: 'Size', value: 'Huge' }] });
  await expect(act).rejects.toThrow('Couldn’t find the option “Huge” in the field “Size”.');
  await expect(select, 'the default isn’t taken for the tester’s pick').toHaveValue('small');
});

test('#1781 a select with the option the tester named picks it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the UAT driver works the page through Chromium’s DevTools protocol');
  const { form, select } = await formIn(page, 'Large size');
  await driver(await runnerPage(page)).act(form.id, { fills: [{ field: 'Size', value: 'large' }] });
  await expect(select).toHaveValue('large');
});
