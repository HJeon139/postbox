// The demo researcher’s explainer follows the guide’s Explainer recipe: asked only to explain, it shows one picture with
// one control that changes it, and no practice app; asked for something to try, it shows the practice app. UAT runs on
// 6 November 2026 found agents building quizzes nobody asked for.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let speed;
test.beforeAll(async () => {
  speed = process.env.POSTBOX_MOCK_SPEED;
  process.env.POSTBOX_MOCK_SPEED = '0.1';
  app = await startPostbox('explainer-default');
});
test.afterAll(async () => {
  await app?.stop();
  if (speed === undefined) delete process.env.POSTBOX_MOCK_SPEED;
  else process.env.POSTBOX_MOCK_SPEED = speed;
});
failOnPageErrors(test);
// The mock reads three papers and streams its reply before the app goes up and its check runs.
test.setTimeout(60_000);

/** A conversation of its own with @researcher, open in the page, that has been sent `text`. */
async function ask(page, title, text) {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title, personaIds: [arrange.persona(rt, 'researcher').id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  rt.sendMessage(t.id, { text });
  return t;
}
const appsIn = (t) =>
  Object.values(app.rt.store.state.apps)
    .filter((a) => a.threadId === t.id)
    .map((a) => a.id);

test('asked to explain, the researcher shows one picture with a control that changes it, and no practice app', async ({ page }) => {
  const t = await ask(page, 'Explain only', 'Explain ReAct');
  await expect.poll(() => app.rt.store.state.apps['react-context']?.check.status, { timeout: 30_000 }).toBe('passed');
  expect(appsIn(t), 'the only app in the conversation').toEqual(['react-context']);
  await expect(page.locator('#main'), 'a predict-first question, with no answer given').toContainText('Guess, then drag it to 8.');

  // A frame takes no pointer events until the page sees the pointer over its app (#38).
  await page.locator('.app-body[data-app-id="react-context"]').hover();
  const inApp = page.locator('iframe.app-iframe[title="How much the loop reads, step by step"]').contentFrame();
  await expect(inApp.locator('#ctx-bars li')).toHaveCount(1);
  await inApp.getByLabel(/Steps in the loop/).fill('8');
  await expect(inApp.locator('#ctx-bars li'), 'the control changes the picture').toHaveCount(8);
  await expect(inApp.getByRole('status')).toHaveText('Step 8 reads 3,720 tokens. The run has read 16,040 in all, 55 times step 1.');
});

test('asked for something to try, the researcher shows the practice app', async ({ page }) => {
  const t = await ask(page, 'Explain with practice', 'Explain ReAct with something I can try');
  await expect.poll(() => appsIn(t), { timeout: 30_000 }).toEqual(['react-practice']);
});
