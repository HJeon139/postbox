// A diagram frame loads only when it nears the view (#695). Every Mermaid figure gets a sandboxed frame that is sent the
// whole Mermaid library and runs it. Loading them all as the conversation opens ran Mermaid once per diagram, and in
// Safari, where the frames share the page’s main thread, a room of 69 diagrams couldn’t take a keystroke for 40 s.
// On a seeded conversation of 30 long replies with a diagram in four of them, far apart: the page counts the diagram
// pages it asks the server for, and a diagram scrolled to still draws.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('diagram-lazy', { demo: false });
  app.store.emit('project', { id: 'pr_lazy', name: 'Lazy diagrams', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const DIAGRAMS = [0, 10, 20, 29];
const LINE = 'The observation is the only outside evidence in the loop, so it keeps the plan grounded.';
/** Reply i: 60 lines, about 1,500 px, and a diagram in four of them. */
const text = (i) =>
  Array.from({ length: 60 }, () => LINE).join('\n\n') + (DIAGRAMS.includes(i) ? `\n\n\`\`\`mermaid\ngraph TD\n  A${i} --> B${i}\n\`\`\`\n` : '');

test('#695: diagrams out of view don’t load, and one scrolled to draws', async ({ page }) => {
  const { rt } = app;
  const p = rt.createPersona({ handle: 'drawer' });
  const t = rt.createThread({ projectId: 'pr_lazy', title: 'Diagrams far apart', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < 30; i++)
    ids.push(rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: text(i), status: 'done' }).id);
  let loads = 0;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/sandbox/mermaid') loads++;
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const figures = page.locator(`.transcript[data-thread="${t.id}"] figure.diagram iframe`);
  await expect(figures, 'a frame for each of the four diagrams').toHaveCount(4);
  // The newest reply’s diagram is in view at the end of the conversation, and draws.
  const last = page.locator(`[data-key="${ids[29]}"] figure.diagram iframe`);
  await expect(last, 'the diagram in view draws').toHaveAttribute('data-sized', '1');
  expect.soft(loads, `diagram pages loaded with the first diagram 40,000 px up: ${loads}`).toBeLessThan(DIAGRAMS.length);
  const first = page.locator(`[data-key="${ids[0]}"] figure.diagram iframe`);
  await first.scrollIntoViewIfNeeded();
  await expect(first, 'the first diagram draws once scrolled to').toHaveAttribute('data-sized', '1');
  expect(loads, 'scrolling to it loaded its page').toBeLessThanOrEqual(DIAGRAMS.length);
});
