// A jump to an item with a diagram in a room of skipped items (#712a): the item is far taller than the estimate it sits
// at until it draws, and its diagram's frame sizes later still, so it changes size twice after the jump. jumpTo
// (app/js/view-jump.mjs) keeps it where its block puts it through both. On a 10,000-item room with ten diagrams, at
// 1280×800, opened at its end: a jump to the first item with a diagram from index 3,000, to its start and to the
// center. The rest of the jumps: view-jump.spec.mjs.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox } from './postbox.mjs';
import { COUNT, jump, landed, openRoom, placed, where } from './view-jump-fixture.mjs';
import { bigRoom } from './view-skipped-fixture.mjs';

// Tracing is off: Playwright's trace snapshots walk every node of the page each action, and on a room of 1,000 items
// or more under content-visibility that takes longer than the test (view-skipped.spec.mjs).
test.use({ colorScheme: 'light', trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let room;
test.beforeAll(async () => {
  app = await startPostbox('view-jump-diagram');
  room = bigRoom(app, 'Jumps to diagrams', COUNT, null, { diagrams: 10 });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);
test.beforeEach(() => test.setTimeout(120_000));

for (const block of /** @type {const} */ (['start', 'center'])) {
  test(`a jump to an item with a diagram, to its ${block}, lands there once it and its diagram have drawn`, async ({ page }) => {
    await openRoom(app, page, room);
    const key = await jump(page, 'diagram', block);
    const atJump = await page.evaluate((k) => document.querySelector(`#main.transcript > [data-key="${k}"]`)?.getBoundingClientRect().height ?? 0, key);
    const frame = page.locator(`#main.transcript > [data-key="${key}"] figure.diagram iframe`);
    await expect(frame, 'its diagram draws').toHaveAttribute('data-sized', '1', { timeout: 15_000 });
    await landed(page);
    // Its diagram's frame sizes itself after it loads, and the jump holds the item's top while it grows, as reading
    // does: so the center is the one for its height when it was jumped to.
    const v = { ...(await where(page, key, block)) };
    if (block === 'center') v.want += (v.height - atJump) / 2;
    test.info().annotations.push({ type: 'measured', description: `${placed(v)}: ${JSON.stringify(v)}` });
    expect.soft(v.mode, 'reading').toBe('reading');
    expect.soft(v.anchor, 'the target is the anchor').toBe(key);
  });
}
