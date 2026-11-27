// Math that streamed into a freshly loaded page came out garbled: `$t$` read “ttt” and a display formula was drawn three
// times on one line (UAT of 26 Nov). The page draws math once KaTeX has loaded, and each redraw of the streaming reply
// asked again while it loaded; each ask then drew the same formula, reading the one before’s drawing as its source.
// Here KaTeX is held back until the reply has been drawn several times, and each formula is drawn once from its source.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
/** Lets the reply go on, one step at a time. */
const steps = [];
const next = () => new Promise((resolve) => steps.push(resolve));
test.beforeAll(async () => {
  app = await startPostbox('math-streamed');
  arrange.withAdapter(app.rt, {
    name: 'mock',
    async deliver(_session, _message, ctx) {
      ctx.text('The cost of a run at step $t$ is\n\n$$C = \\sum_{t=1}^{T} c_t$$\n\n');
      await next();
      ctx.text('where $c_t$ is ');
      await next();
      ctx.text('one step’s cost.');
    },
  });
  const persona = app.rt.createPersona({ handle: 'worker' });
  thread = app.rt.createThread({ projectId: Object.values(app.store.state.projects)[0].id, title: 'Streamed math', personaIds: [persona.id] });
});
test.afterAll(async () => {
  for (const go of steps) go();
  await app?.stop();
});
failOnPageErrors(test);

test('math streamed into a page still loading KaTeX is drawn once, from its source', async ({ page }) => {
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/kit/vendor/katex/katex.min.js', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await page.getByRole('textbox', { name: /^Message/ }).fill('Explain the cost');
  await page.keyboard.press('Enter');
  const reply = page.locator('.transcript .md').filter({ hasText: 'The cost of a run' });
  await expect(reply).toBeVisible();
  // Two more redraws of the reply while KaTeX is still loading.
  await expect.poll(() => steps.length).toBe(1);
  steps.shift()?.();
  await expect(reply).toContainText('where');
  await expect.poll(() => steps.length).toBe(1);
  steps.shift()?.();
  await expect(reply).toContainText('one step’s cost.');
  release();
  const math = reply.locator('.md-math');
  await expect(math).toHaveCount(3);
  await expect(math.locator('.katex')).toHaveCount(3);
  // KaTeX keeps each formula’s source in its MathML: what it drew from.
  await expect(math.locator('annotation')).toHaveText(['t', 'C = \\sum_{t=1}^{T} c_t', 'c_t']);
  await expect(math.nth(1).locator('.katex-display'), 'the display formula is drawn once').toHaveCount(1);
});
