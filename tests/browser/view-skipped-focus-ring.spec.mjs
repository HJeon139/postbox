// A skipped item clips its paint to its own box (content-visibility: auto contains paint, #712a), so the focus ring of
// a reaction button flush with the item’s bottom edge was cut off below it (#712a). The item
// gives its paint 4 px of room past its box (overflow-clip-margin, app/workbench.css). Here the strip just below the
// item is captured with the button focused and not: the ring shows there only if it isn’t clipped.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-focus-ring');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#712a a reaction button flush with its item’s bottom keeps its whole focus ring', async ({ page }) => {
  const { rt } = app;
  const project = Object.values(app.store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: 'Focus ring', personaIds: [arrange.persona(rt, 'critic').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  const reply = arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: 'A reply.', status: 'done' });
  arrange.post(rt, t.id, { kind: 'user', text: 'A message after it.' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await settled(page);
  const item = page.locator(`#main.transcript.cv-skip > [data-key="${reply.id}"]`);
  const button = item.locator('.react-btn').first();
  await expect(button).toBeVisible();
  const box = await item.evaluate((n) => {
    const r = n.getBoundingClientRect();
    return { x: r.x, bottom: r.bottom, width: r.width };
  });
  const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await button.boundingBox());
  expect(Math.abs(b.y + b.height - box.bottom), 'the button sits flush with the item’s bottom').toBeLessThanOrEqual(1);
  // The 3 px strip below the item, under the button: the ring is 2 px wide, 1 px out from the button.
  const strip = { x: b.x - 4, y: box.bottom, width: b.width + 8, height: 3 };
  const shot = () => page.screenshot({ clip: strip, animations: 'disabled', caret: 'hide' });
  await button.evaluate((n) => n.blur());
  const blurred = await shot();
  await button.evaluate((n) => /** @type {any} */ (n).focus({ focusVisible: true }));
  await expect(button).toBeFocused();
  const focused = await shot();
  expect(focused.equals(blurred), 'the focus ring shows below the item').toBe(false);
});
