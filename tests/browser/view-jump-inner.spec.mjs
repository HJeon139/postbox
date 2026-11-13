// A jump to something deep inside a tall item that the browser skips (#712a): the item is drawn to measure the target,
// and stays drawn until the browser has painted it. Let go sooner, it falls back to its 71 px estimate, the target is
// left off screen, and it's skipped again: a diagram there would never load.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-jump-inner', { demo: false });
  app.store.emit('project', { id: 'pr_inner', name: 'Inner jumps', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const LINE = 'The observation is the only outside evidence in the loop, so it keeps the plan grounded.';
/** Reply i: 60 lines, about 1,500 px, the first ending in a diagram. */
const text = (/** @type {number} */ i) => Array.from({ length: 60 }, () => LINE).join('\n\n') + (i === 0 ? '\n\n```mermaid\ngraph TD\n  A --> B\n```\n' : '');

test('a jump to a diagram at the end of a tall skipped reply far above draws it, centered, and its item is the anchor', async ({ page }) => {
  const { rt } = app;
  const p = rt.createPersona({ handle: 'drawer' });
  const t = rt.createThread({ projectId: 'pr_inner', title: 'A diagram far up', personaIds: [p.id] });
  const se = arrange.agentIn(rt, t.id);
  const ids = [];
  for (let i = 0; i < 30; i++)
    ids.push(arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: text(i), status: 'done' }).id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const frame = page.locator(`[data-key="${ids[0]}"] figure.diagram iframe`);
  await expect(frame).toBeAttached();
  await settled(page);
  await frame.evaluate(async (n) => (await import('/app/js/view-jump.mjs')).jumpTo(n));
  await expect(frame, 'the diagram draws once jumped to').toHaveAttribute('data-sized', '1');
  await settled(page);
  const v = await frame.evaluate((n) => {
    const r = n.getBoundingClientRect();
    const el = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'));
    return { top: r.top, bottom: r.bottom, mode: el.dataset.viewMode, anchor: el.dataset.viewAnchor };
  });
  expect(v.top, 'the diagram is in view').toBeGreaterThan(0);
  expect(v.bottom, 'the diagram is in view').toBeLessThan(800);
  expect([v.mode, v.anchor], 'its reply is the anchor').toEqual(['reading', ids[0]]);
});
