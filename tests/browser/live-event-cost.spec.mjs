// A live event costs about the same in a long conversation as in a short one (#622). While agents work, the page hears
// a `session` change many times a second and a `thread` change with each message. In a room of 3,499 items, each
// `session` change rebuilt the ring beside every reply its agent ever wrote, about 300 SVGs, and each layout after an
// event walked the whole transcript, 389,000 layout objects: 95 ms of layout a `session` change, 62 ms a `thread` one.
// On a seeded room of 1,000 items (two agents’ replies with activity steps and reactions, your messages, a few diagrams
// and confirm blocks), the page counts the ring SVGs it builds and the activity lists it takes out while session and
// thread events arrive, and Chromium counts the layout work they cost.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('live-event-cost', { demo: false });
  app.store.emit('project', { id: 'pr_live', name: 'Live', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const ITEMS = 1000;
const DIAGRAM = '\n\n```mermaid\ngraph TD\n  A --> B\n```\n';
const STEPS = [
  { kind: 'tool', label: 'read src/store.mjs', state: 'done', ms: 40 },
  { kind: 'thought', label: 'The store keeps one list per conversation.', state: 'done' },
  { kind: 'tool', label: 'grep sessionPatch', state: 'done', ms: 25 },
  { kind: 'tool', label: 'npm test', state: 'done', ms: 2400 },
];
const confirm = (i) => ({
  id: `ok${i}`,
  type: 'confirm',
  version: 1,
  fallback: `Ship step ${i}?`,
  statement: `Ship step ${i} to main?`,
  confirmLabel: 'Ship it',
});

/** A room of 1,000 items with two agents, open in the page and held at its end, with its sessions and thread. */
async function seeded(page) {
  const { rt, store } = app;
  const a = rt.createPersona({ handle: 'maker' });
  const b = rt.createPersona({ handle: 'checker' });
  const t = rt.createThread({ projectId: 'pr_live', title: 'Long room', personaIds: [a.id, b.id] });
  const [sa, sb] = rt.sessionsIn(t.id);
  for (let i = 0; i < ITEMS; i++) {
    const se = i % 4 === 1 ? sa : sb;
    const turnId = `tu_${i}`;
    if (i % 4 === 0) rt.addItem(t.id, { kind: 'user', text: `Message ${i}: carry on with the next part.`, status: 'done' });
    else if (i % 150 === 3) {
      rt.toolsFor(se.id).show_block({ block: confirm(i) });
    } else {
      const id = rt.addItem(t.id, {
        kind: 'agent',
        sessionId: se.id,
        personaId: se.personaId,
        handle: se.handle,
        turnId,
        text: `Reply ${i} says what it found. `.repeat(6) + (i % 200 === 2 ? DIAGRAM : ''),
        status: 'done',
        activity: { steps: STEPS.map((s, k) => ({ ...s, id: `st_${i}_${k}` })) },
      }).id;
      if (i % 3 === 0) store.emit('item.patch', { threadId: t.id, id, patch: { reactions: [{ emoji: '👍', at: 1 }] } });
    }
  }
  await page.addInitScript(countWork);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > [data-key]`)).toHaveCount(ITEMS, { timeout: 30_000 });
  await synced(page, app);
  await settled(page);
  return { t, sa, sb };
}

/**
 * Runs in the page before Postbox does: counts ring SVGs built (rings: each SVG, the moving overlays too; stills: the
 * SVG of a ring beside a message itself) and activity lists taken out, in window.__work.
 */
function countWork() {
  const w = { rings: 0, stills: 0, activity: 0 };
  Object.defineProperty(window, '__work', { value: w });
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.target instanceof Element && r.target.matches('pb-ring'))
        for (const n of r.addedNodes)
          if (n instanceof SVGSVGElement) {
            w.rings++;
            if (n.getAttribute('role') === 'img' && r.target.closest('.transcript .who')) w.stills++;
          }
      for (const n of r.removedNodes) if (n instanceof Element && n.matches('details.activity')) w.activity++;
    }
  }).observe(document, { childList: true, subtree: true });
}

/** Chromium’s cumulative counters, by name. */
async function metrics(cdp) {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

/** Sends n events, one a time, waiting for the page to hear each and draw; returns the per-event medians. */
async function perEvent(page, n, send) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const each = [];
  for (let i = 0; i < n; i++) {
    const was = await page.evaluate(() => ({ .../** @type {any} */ (window).__work }));
    const a = await metrics(cdp);
    send(i);
    await synced(page, app);
    await frames(page);
    const b = await metrics(cdp);
    const now = await page.evaluate(() => ({ .../** @type {any} */ (window).__work }));
    each.push({ rings: now.rings - was.rings, activity: now.activity - was.activity, layoutMs: (b.LayoutDuration - a.LayoutDuration) * 1000 });
  }
  await cdp.detach();
  const median = (/** @type {number[]} */ xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  return {
    rings: Math.max(...each.map((e) => e.rings)),
    activity: Math.max(...each.map((e) => e.activity)),
    layoutMs: Math.round(median(each.map((e) => e.layoutMs)) * 10) / 10,
  };
}

test('#622: a ring whose agent changes state and context at once builds its SVG once', async ({ page }) => {
  const p = app.rt.createPersona({ handle: 'once' });
  const t = app.rt.createThread({ projectId: 'pr_live', title: 'Once', personaIds: [p.id] });
  const se = app.rt.sessionsIn(t.id)[0];
  app.rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: 'One reply.', status: 'done' });
  await page.addInitScript(countWork);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const ring = page.locator(`.transcript .who pb-ring[data-session="${se.id}"]`);
  await expect(ring).toHaveAttribute('state', 'idle');
  const was = await page.evaluate(() => /** @type {any} */ (window).__work.stills);
  app.rt.updateSession(se.id, { state: 'think', ctx: 40, subagents: [{ name: 'reader', state: 'tool', ctx: 10 }] });
  await expect(ring).toHaveAttribute('state', 'think');
  await frames(page);
  const built = (await page.evaluate(() => /** @type {any} */ (window).__work.stills)) - was;
  expect(built, 'the ring’s SVG, built once for its state, context and subagent together').toBe(1);
});

test('#622: a session event in a 1,000-item room rebuilds the rings that show it, not one per reply', async ({ page }) => {
  test.setTimeout(180_000);
  const { t, sa } = await seeded(page);
  const STATES = ['think', 'tool', 'gen', 'needs'];
  const session = await perEvent(page, 8, (i) => app.rt.updateSession(sa.id, { state: STATES[i % 4], ctx: 20 + i, currentStep: `Step ${i}` }));
  test.info().annotations.push({ type: 'measured', description: `per session event: ${JSON.stringify(session)}` });
  expect.soft(session.rings, `ring SVGs built per session event, in the whole page, not one per reply (${JSON.stringify(session)})`).toBeLessThanOrEqual(20);
  expect.soft(session.activity, 'activity lists taken out per session event').toBe(0);
  // The ring beside @maker’s latest reply follows it; the 249 beside its earlier replies rest, as the words beside
  // its name show only on the latest.
  app.rt.updateSession(sa.id, { state: 'think', ctx: 33 });
  const rings = page.locator(`.transcript[data-thread="${t.id}"] .who pb-ring[data-session="${sa.id}"]`);
  await expect.soft(rings.last()).toHaveAttribute('state', 'think');
  await expect.soft(rings.last()).toHaveAttribute('ctx', '33');
  await expect.soft(rings.nth(0)).toHaveAttribute('state', 'idle');
  expect.soft(await rings.evaluateAll((rs) => rs.filter((r) => r.getAttribute('state') !== 'idle').length), 'rings showing the live state').toBe(1);
});
