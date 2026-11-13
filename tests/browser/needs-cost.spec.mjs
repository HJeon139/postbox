// Going to an agent's ask far up a long room opened at its end (#285, #1155), with ⌃J or the agent's “1 open choice”
// link: the ask is placed with the work main does for it, no load and no more layouts, though the page holds only the
// newest range when the room opens. The time from the key or click to the frame that paints the ask is recorded.
//
// The layouts counted are each press's own: those between the key or click and the end of the frame that paints the ask,
// from a trace marked at both. The page's layout count read before and after a press took in more: the browser's layout
// for Playwright's check of the last press, and the outline's animation frames until the count was read, more of them
// the busier the machine (one press counted 6 to 12 with the whole suite running). The page runs with reduced motion:
// an agent's pulsing needs-you ring lays the page out on some frames of its own, which fell inside a press now and then,
// on main as on this branch, whatever the press did. And only the page's own layouts count: an icon drawn as a CSS
// mask is an SVG document of its own, laid out again, three objects, when it's drawn at a size other than the last,
// as when the sidebar repaints between the transcript's icons.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, newestShown, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('needs-cost');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/**
 * Main’s layouts for one press, measured with these cases on origin/main beside #1155’s branch, 60 presses of each:
 * every one was 4 for ⌃J and 3 for the link.
 */
const MAIN_LAYOUTS = { ctrlJ: 4, openAsks: 3 };

const choice = (id) => ({
  id,
  type: 'choice',
  version: 1,
  title: 'Which source first?',
  fallback: 'Which source first?',
  options: [
    { id: 'a', label: 'The papers' },
    { id: 'b', label: 'The notes' },
  ],
});

/**
 * A room of `count` items whose agent asked twice far up it: its need at item 100, and an ask it left open at item 300,
 * which its “1 open choice” link goes to. Resolves the room, its agent's session and the two asks' ids.
 */
function roomWithAsks(title, count = 10_000) {
  const projectId = /** @type {any} */ (Object.values(app.rt.store.state.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title, personaIds: [arrange.persona(app.rt, 'researcher').id] });
  const se = arrange.agentIn(app.rt, room.id);
  const key = `${room.id.slice(-6)}`;
  const asks = { need: `it_need_${key}`, open: `it_open_${key}` };
  /** @type {Record<number, string>} */
  const askAt = { 100: asks.need, 300: asks.open };
  for (let i = 0; i < count; i++) {
    const id = askAt[i] ?? `it_${key}_${i}`;
    const item = askAt[i]
      ? { id, kind: 'block', handle: 'researcher', sessionId: se.id, personaId: se.personaId, valid: true, block: choice(`b${i}`) }
      : { id, kind: i % 3 ? 'agent' : 'user', handle: i % 3 ? 'researcher' : undefined, text: `Item ${i} of the release log; nothing here needs anyone.` };
    app.store.emit('item.add', { threadId: room.id, item: { ...item, at: Date.now() - (count - i) * 1000 } });
  }
  arrange.setSession(app.rt, se.id, { state: 'needs', needs: { kind: 'block', itemId: asks.need, text: 'Which source first?' } });
  return { room, se, asks };
}

/**
 * Presses ⌃J or clicks `act`, and resolves the ms until `item` is outlined on the page and painted, or -1 past 3 s.
 * The trace gets a mark at the press and one when the frame that paints the item has laid out.
 */
const press = (page, item, act) =>
  page.evaluate(
    ([k, how]) =>
      new Promise((done) => {
        const t0 = performance.now();
        // The moment the ask is outlined, whatever order the page's frame callbacks run in, then the frame that
        // paints it.
        const arrived = () => document.querySelector(`#main > [data-key="${k}"].arrived`);
        let over = false;
        const watch = new MutationObserver(() => {
          if (over || !arrived()) return;
          over = true;
          watch.disconnect();
          requestAnimationFrame(() => {
            const took = Math.round(performance.now() - t0);
            // The frame that paints it has laid out by the next one's callbacks.
            requestAnimationFrame(() => {
              console.timeStamp('pb-painted');
              done(took);
            });
          });
        });
        watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        // Past 3 s, -1: checked each frame, apart from the watch, so it doesn't change when the outline is seen.
        const late = () => {
          if (over) return;
          if (performance.now() - t0 < 3000) return requestAnimationFrame(late);
          over = true;
          watch.disconnect();
          done(-1);
        };
        requestAnimationFrame(late);
        console.timeStamp('pb-press');
        if (how === 'ctrlJ') document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, bubbles: true }));
        /** @type {HTMLElement} */ else document.querySelector(how).click();
      }),
    [item, act],
  );

/**
 * Opens the room at its end, then does `act` six times from there, each on a load of the page of its own, and records
 * the items loaded, the layouts and the ms until `item` is outlined on the page and painted, for each.
 */
async function measure(page, room, item, act) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let loads = 0;
  page.on('request', (r) => r.url().includes(`/api/threads/${room.id}/items`) && loads++);
  const cdp = await page.context().newCDPSession(page);
  /** @type {any[]} */
  let traced = [];
  cdp.on('Tracing.dataCollected', (e) => traced.push(...e.value));
  const pageFrame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  const runs = [];
  for (let i = 0; i < 6; i++) {
    await page.goto(`${app.origin}/?visit=${i}#/t/${room.id}`);
    await synced(page, app);
    await newestShown(page, app, room.id);
    await settled(page);
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    const loadsBefore = loads;
    traced = [];
    await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
    const ms = await press(page, item, act);
    const ended = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await ended;
    const at = (/** @type {string} */ mark) => traced.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === mark)?.ts;
    const [from, to] = [at('pb-press'), at('pb-painted')];
    expect(from && to, 'both marks in the trace').toBeTruthy();
    const layouts = traced.filter((e) => e.name === 'Layout' && e.args?.beginData?.frame === pageFrame && e.ts > from && e.ts < to).length;
    runs.push({ ms, loads: loads - loadsBefore, layouts });
    await expect(page.locator(`#main > [data-key="${item}"]`)).toBeInViewport();
  }
  return runs;
}

test('#1155 ⌃J to an ask far up a 10,000-item room does main’s work: no load, and no more layouts', async ({ page }) => {
  test.setTimeout(120_000);
  const { room, asks } = roomWithAsks('10,000 items, an ask at 100');
  const runs = await measure(page, room, asks.need, 'ctrlJ');
  console.log(`CTRLJ ${JSON.stringify(runs)}`);
  test.info().annotations.push({ type: 'measured', description: `⌃J: ${JSON.stringify(runs)}` });
  expect(
    runs.map((r) => r.loads),
    'items loaded by ⌃J: none, as on main',
  ).toEqual(runs.map(() => 0));
  for (const r of runs) expect(r.layouts, `layouts for ⌃J: ${JSON.stringify(runs)}`).toBeLessThanOrEqual(MAIN_LAYOUTS.ctrlJ);
});

test('#1155 an agent’s open-asks link to a block far up a 10,000-item room does main’s work: no load, and no more layouts', async ({ page }) => {
  test.setTimeout(120_000);
  const { room, se, asks } = roomWithAsks('10,000 items, an open ask at 300');
  const runs = await measure(page, room, asks.open, `button[data-open-asks="${se.id}"]`);
  console.log(`OPENASKS ${JSON.stringify(runs)}`);
  test.info().annotations.push({ type: 'measured', description: `Open asks: ${JSON.stringify(runs)}` });
  expect(
    runs.map((r) => r.loads),
    'items loaded by the link: none, as on main',
  ).toEqual(runs.map(() => 0));
  for (const r of runs) expect(r.layouts, `layouts for the link: ${JSON.stringify(runs)}`).toBeLessThanOrEqual(MAIN_LAYOUTS.openAsks);
});
