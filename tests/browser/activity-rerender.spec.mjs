// An activity step redraws only its reply’s activity list (#573). Each tool call, thought or step of a turn sends one
// item.patch with an activityStep, and the transcript used to build the whole reply again for it: a new Markdown box, a
// new reply node, and a new sandboxed frame for every diagram in the reply, once per step.
// On a seeded conversation of 100 agent replies, the last holding a Mermaid diagram, the page counts its own work while
// steps arrive: Markdown boxes changed, diagram frames added and removed, and reply nodes replaced. Chromium’s layout,
// style and script counters are recorded beside them.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('activity-rerender', { demo: false });
  app.store.emit('project', { id: 'pr_steps', name: 'Steps', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const DIAGRAM = '\n\n```mermaid\ngraph TD\n  A --> B\n```\n';
const text = (i) => `Reply ${i} says something worth reading. `.repeat(8) + (i === 99 ? DIAGRAM : '');

/** A conversation of 100 agent replies open in the page, the last one’s diagram drawn, and a way to send it a step. */
async function seeded(page, name) {
  const { rt } = app;
  const p = rt.createPersona({ handle: name });
  const t = rt.createThread({ projectId: 'pr_steps', title: `Steps ${name}`, personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  let last = '';
  for (let i = 0; i < 100; i++)
    last = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: text(i), status: 'done' }).id;
  await page.addInitScript(countWork);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const reply = page.locator(`.transcript[data-thread="${t.id}"] [data-key="${last}"]`);
  await expect(reply.locator('figure.diagram iframe'), 'the diagram, drawn in a frame').toHaveCount(1);
  /** @param {Record<string, any>} step */
  const step = (step) => app.store.emit('item.patch', { threadId: t.id, id: last, activityStep: { state: 'done', ms: 120, ...step } });
  return { t, reply, step };
}

/**
 * Runs in the page before Postbox does: counts the Markdown boxes whose children changed, diagram frames added and
 * removed, and reply nodes ([data-key]) removed from the transcript. window.__work.reset() starts the counts again.
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
  new MutationObserver((records) => {
    for (const r of records) {
      const target = r.target instanceof Element ? r.target : null;
      if (target?.matches('.md')) boxes.add(target);
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

/** Sends the steps, waits for the page to hear them and draw, and returns its counts, recorded on the test as #573’s measurement. */
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

test('#573: 10 activity steps change the step list and no Markdown box, frame or reply node', async ({ page }) => {
  const { reply, step } = await seeded(page, 'ten');
  const work = await measure(page, () => {
    for (let i = 1; i <= 10; i++) step({ id: `tool_${i}`, label: `Read file-${i}.md` });
  });
  // The list shows all ten: the steps were drawn, so the counts below aren’t from a page at rest.
  await expect(reply.locator('details.activity > summary'), 'the summary counts the steps').toContainText('10');
  await expect(reply.locator('details.activity ul.steps > li'), 'one row a step').toHaveCount(10);
  expect.soft(work.md, `Markdown boxes changed: ${work.md}`).toBe(0);
  expect.soft(work.framesAdded, `diagram frames added: ${work.framesAdded}`).toBe(0);
  expect.soft(work.framesRemoved, `diagram frames removed: ${work.framesRemoved}`).toBe(0);
  expect.soft(work.repliesRemoved, `reply nodes replaced: ${work.repliesRemoved}`).toBe(0);
});

test('#573: the diagram’s frame, an open list, an expanded thought and a selection survive a step', async ({ page }) => {
  const { reply, step } = await seeded(page, 'keeps');
  step({ id: 'think_1', kind: 'thought', label: 'Planning', detail: 'First the files, then the tests.' });
  step({ id: 'tool_1', label: 'Read a.md', state: 'running' });
  await expect(reply.locator('details.activity ul.steps > li')).toHaveCount(2);
  const frame = reply.locator('figure.diagram iframe');
  await frame.evaluate((el) => {
    /** @type {any} */ (el).__before = true;
  });
  await reply.locator('details.activity > summary').click();
  await reply.locator('details.step-text > summary').click();
  await reply.locator(':scope > .md p').first().dblclick();
  const selected = () => page.evaluate(() => String(getSelection()));
  const before = await selected();
  expect(before, 'a word selected by double-click').toMatch(/\w/);

  step({ id: 'tool_1', label: 'Read a.md', state: 'done' });
  step({ id: 'tool_2', label: 'Read b.md' });
  await expect(reply.locator('details.activity ul.steps > li'), 'the new step is listed').toHaveCount(3);
  await expect(reply.locator('details.activity > summary'), 'nothing is running now').not.toContainText('running');
  expect.soft(await frame.evaluate((el) => /** @type {any} */ (el).__before === true), 'the same frame element, not a new one').toBe(true);
  await expect.soft(reply.locator('details.activity'), 'the list stays open').toHaveAttribute('open', '');
  await expect.soft(reply.locator('details.step-text'), 'the thought stays expanded').toHaveAttribute('open', '');
  expect.soft(await selected(), 'the selection survives').toBe(before);
});

test('#573: a background job’s row comes with its step and goes when it ends', async ({ page }) => {
  const { reply, step } = await seeded(page, 'job');
  step({ id: 'job_1', label: 'npm run dev', state: 'running', job: 'j1' });
  await expect(reply.getByRole('list', { name: 'Background jobs' }).getByRole('listitem'), 'the job’s row').toHaveCount(1);
  await expect(reply.locator('details.activity > summary')).toContainText('background work running');
  step({ id: 'job_1', label: 'npm run dev', state: 'done', job: 'j1' });
  await expect(reply.getByRole('list', { name: 'Background jobs' }), 'no row once it ended').toHaveCount(0);
  await expect(reply.locator('details.activity > summary')).not.toContainText('running');
});

test('#573: a whole step list, as a terminal’s mirror sends it, changes no Markdown box, frame or reply node', async ({ page }) => {
  const { t, reply } = await seeded(page, 'mirror');
  const id = await reply.getAttribute('data-key');
  /** @type {any[]} */
  const steps = [];
  const work = await measure(page, () => {
    for (let i = 1; i <= 5; i++) {
      steps.push({ id: `tool_${i}`, label: `Read file-${i}.md`, state: 'running', ms: null });
      app.store.emit('item.patch', { threadId: t.id, id, patch: { activity: { steps: steps.map((s) => ({ ...s })) } } });
      steps[i - 1].state = 'done';
      app.store.emit('item.patch', { threadId: t.id, id, patch: { activity: { steps: steps.map((s) => ({ ...s })) } } });
    }
  });
  await expect(reply.locator('details.activity ul.steps > li'), 'one row a step').toHaveCount(5);
  await expect(reply.locator('details.activity > summary')).not.toContainText('running');
  expect.soft(work.md, `Markdown boxes changed: ${work.md}`).toBe(0);
  expect.soft(work.framesAdded + work.framesRemoved, `diagram frames added or removed: ${work.framesAdded + work.framesRemoved}`).toBe(0);
  expect.soft(work.repliesRemoved, `reply nodes replaced: ${work.repliesRemoved}`).toBe(0);
});
