// Defining a glossary term redraws only the replies that use it (#564). Today one `glossary` event sets the Markdown of
// every agent reply in the conversation again, and builds a new sandboxed frame for every diagram in them, so one
// define_term in a long room costs a rebuild per reply and a reload of every diagram.
// On a seeded conversation of 100 agent replies: three hold a Mermaid diagram, and two use the term “widget”, one of
// those with a diagram. The page counts its own work while the term is defined: Markdown boxes changed, diagram frames
// added and removed, and reply nodes replaced. Chromium’s layout, style and script counters are recorded beside them.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('glossary-rerender', { demo: false });
  app.store.emit('project', { id: 'pr_gloss', name: 'Glossary', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const DIAGRAM = (n) => `Here is step ${n}.\n\n\`\`\`mermaid\ngraph TD\n  A${n} --> B${n}\n\`\`\`\n`;
/** Reply i’s text: 10 and 70 use the term, 10, 40 and 90 hold a diagram. */
const text = (i) => {
  const words = i === 10 || i === 70 ? `Reply ${i} counts each widget once. ` : `Reply ${i} talks about something else. `;
  return words.repeat(8) + (i === 10 || i === 40 || i === 90 ? DIAGRAM(i) : '');
};

/** A conversation of 100 agent replies, open in the page with its three diagrams in place, and its define_term. */
async function seeded(page, name) {
  const { rt } = app;
  const p = rt.createPersona({ handle: name });
  const t = rt.createThread({ projectId: 'pr_gloss', title: `Glossary ${name}`, personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < 100; i++)
    ids.push(rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: text(i), status: 'done' }).id);
  await page.addInitScript(countWork);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] figure.diagram iframe`), 'the three diagrams, drawn in frames').toHaveCount(3);
  return { t, ids, define: rt.toolsFor(se.id).define_term };
}

/**
 * Runs in the page before Postbox does: counts the Markdown boxes whose children changed (an innerHTML write or a block
 * put in or taken out), diagram frames added and removed, and reply nodes ([data-key]) removed from the transcript.
 * window.__work.reset() starts the counts again.
 */
function countWork() {
  const boxes = new Set();
  const w = { md: 0, framesAdded: 0, framesRemoved: 0, repliesRemoved: 0 };
  const reset = () => {
    boxes.clear();
    Object.assign(w, { md: 0, framesAdded: 0, framesRemoved: 0, repliesRemoved: 0 });
  };
  Object.defineProperty(window, '__work', { value: { counts: w, reset } });
  const frames = (/** @type {Node} */ n) => (n instanceof Element ? (n.matches('iframe') ? 1 : n.querySelectorAll('iframe').length) : 0);
  // The caret a streaming reply ends with comes and goes on its own; it isn't the reply being drawn again.
  const caret = (/** @type {Node} */ n) => n instanceof Element && n.matches('.caret');
  new MutationObserver((records) => {
    for (const r of records) {
      const target = r.target instanceof Element ? r.target : null;
      if (target?.matches('.md') && [...r.addedNodes, ...r.removedNodes].some((n) => !caret(n))) boxes.add(target);
      for (const n of r.addedNodes) w.framesAdded += frames(n);
      for (const n of r.removedNodes) {
        w.framesRemoved += frames(n);
        if (target?.closest('.transcript') && n instanceof Element && n.matches('[data-key]')) w.repliesRemoved++;
      }
    }
    w.md = boxes.size;
  }).observe(document, { childList: true, subtree: true });
}

/** Chromium’s cumulative counters, by name. */
async function metrics(cdp) {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

/**
 * Defines a term through the agent’s tool, waits for the page to hear it and draw, and returns the page’s counts and
 * Chromium’s, as differences from just before. Each is recorded on the test, failing or not, as #564’s measurement.
 */
async function measure(page, run) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.evaluate(() => /** @type {any} */ (window).__work.reset());
  const before = await metrics(cdp);
  run();
  await synced(page, app);
  await frames(page);
  const after = await metrics(cdp);
  await cdp.detach();
  const counts = await page.evaluate(() => ({ .../** @type {any} */ (window).__work.counts }));
  const chromium = {
    layouts: after.LayoutCount - before.LayoutCount,
    styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount,
    scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
  };
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ ...counts, ...chromium }) });
  return counts;
}

test('#564: defining a term used in 2 of 100 replies changes those 2 and reloads no diagram', async ({ page }) => {
  const { t, define } = await seeded(page, 'counter');
  const work = await measure(page, () => define({ term: 'widget', definition: 'One unit of the thing counted.' }));
  // The two replies that use it show it as a term: the event was drawn, so the counts below aren’t from a page at rest.
  await expect(page.locator(`.transcript[data-thread="${t.id}"] .md:has(.term[data-term="widget"])`), 'the term, marked in both replies').toHaveCount(2);
  expect.soft(work.md, `Markdown boxes changed: ${work.md}`).toBeLessThanOrEqual(2);
  expect.soft(work.framesAdded, `diagram frames added: ${work.framesAdded}`).toBe(0);
  expect.soft(work.framesRemoved, `diagram frames removed: ${work.framesRemoved}`).toBe(0);
  expect.soft(work.repliesRemoved, 'no reply node is replaced').toBe(0);
});

test('#564: a glossary event that leaves every reply’s HTML the same changes no Markdown box', async ({ page }) => {
  const { t, define } = await seeded(page, 'same');
  define({ term: 'widget', definition: 'One unit of the thing counted.' });
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] .md:has(.term[data-term="widget"])`)).toHaveCount(2);
  // A new definition for the same term changes the card, not the replies: they mark the term the same way.
  const work = await measure(page, () => define({ term: 'widget', definition: 'One unit of the thing counted, revised.' }));
  expect.soft(work.md, `Markdown boxes changed: ${work.md}`).toBe(0);
  expect.soft(work.framesAdded + work.framesRemoved, 'no diagram frame added or removed').toBe(0);
});

test('#564: a diagram in a reply that uses the new term keeps its frame', async ({ page }) => {
  const { t, ids, define } = await seeded(page, 'keeps');
  const frame = page.locator(`.transcript[data-thread="${t.id}"] [data-key="${ids[10]}"] figure.diagram iframe`);
  await expect(frame).toHaveCount(1);
  await frame.evaluate((el) => {
    /** @type {any} */ (el).__before = true;
  });
  define({ term: 'widget', definition: 'One unit of the thing counted.' });
  await synced(page, app);
  await expect(page.locator(`.transcript [data-key="${ids[10]}"] .md:has(.term[data-term="widget"])`), 'the reply was redrawn with the term').toHaveCount(1);
  expect(await frame.evaluate((el) => /** @type {any} */ (el).__before === true), 'the same frame element, not a new one').toBe(true);
});

test('#564: text selected in a reply that doesn’t use the new term stays selected', async ({ page }) => {
  const { ids, define } = await seeded(page, 'select');
  const box = page.locator(`.transcript [data-key="${ids[50]}"] .md`);
  await box.scrollIntoViewIfNeeded();
  await box.dblclick();
  const selected = () => page.evaluate(() => String(getSelection()));
  const before = await selected();
  expect(before, 'a word selected by double-click').not.toBe('');
  define({ term: 'widget', definition: 'One unit of the thing counted.' });
  await synced(page, app);
  await expect(page.locator('.transcript .md:has(.term[data-term="widget"])')).toHaveCount(2);
  expect(await selected(), 'the selection survives').toBe(before);
});
