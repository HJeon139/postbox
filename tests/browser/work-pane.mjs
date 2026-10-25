// What the right-pane specs share (#132): a Postbox whose demo “Citation fixes” has the mock @researcher’s two turns
// of work and a topic thread long enough to scroll, the pane’s addresses, and the checks every pane test makes.

import { expect } from '@playwright/test';
import { startPostbox, synced } from './postbox.mjs';

export const WORK = 'aside.workpane';
export const THREAD = 'aside.sidepanel';
/** The widths every pane test runs at, a phone’s emulated. */
export const SIZES = [
  { width: 1280, height: 900, phone: false },
  { width: 375, height: 812, phone: true },
];

/**
 * Starts a spec’s Postbox, has @researcher do the demo’s two turns of work in “Citation fixes” (fast: the mock’s pace is
 * set for the spec and put back by stop()), and starts a topic thread there.
 * @param {string} name
 */
export async function citationFixes(name) {
  const speed = process.env.POSTBOX_MOCK_SPEED;
  process.env.POSTBOX_MOCK_SPEED = '0.1';
  const app = await startPostbox(name);
  const { rt, store } = app;
  const conv = Object.values(store.state.threads).find((t) => t.title === 'Citation fixes');
  const other = Object.values(store.state.threads).find((t) => t.title === 'Agent memory papers');
  const turnsDone = () => (store.state.work?.[conv.id] ?? []).filter((e) => e.kind === 'turn' && e.status !== 'running').length;
  rt.sendMessage(conv.id, { text: 'Fix the citation script' });
  await expect.poll(turnsDone, { message: 'the first turn’s work', timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  rt.sendMessage(conv.id, { text: 'Try a faster parser' });
  await expect.poll(turnsDone, { message: 'the second turn’s work', timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  const turns = store.state.work[conv.id].filter((e) => e.kind === 'turn');
  const root = store.items(conv.id).find((i) => i.kind === 'agent');
  const topic = rt.startTopic(conv.id, root.id).threadId;
  // Long enough to scroll, in the pane and full screen.
  for (let i = 0; i < 24; i++)
    rt.addItem(topic, {
      kind: 'user',
      text: `Side question ${i + 1}: ${'a longer line that wraps across the panel and reads at the column width, '.repeat(3)}`,
    });
  /** The conversation’s address with that pane part. */
  const pane = (r) => `#/t/${conv.id}${r}`;
  return {
    app,
    conv,
    other,
    topic,
    turns,
    pane,
    /** Opens the conversation with that pane address, and waits for it to have heard everything the server did. */
    async open(page, r) {
      await page.goto(`${app.origin}/${pane(r)}`);
      await synced(page, app);
      await expect(page.locator('header.topbar #work-button')).toBeVisible();
    },
    /** Goes to another address in the same page, as the app’s links do. */
    async go(page, hash) {
      await synced(page, app);
      await page.evaluate((h) => {
        location.hash = h;
      }, hash);
      await expect(page.locator('header.topbar')).toBeVisible();
    },
    async stop() {
      await app.stop();
      if (speed === undefined) delete process.env.POSTBOX_MOCK_SPEED;
      else process.env.POSTBOX_MOCK_SPEED = speed;
    },
  };
}

/** @param {import('@playwright/test').Page} page */
export const hash = (page) => page.evaluate(() => location.hash);

/** Nothing scrolls sideways: not the page, not the pane, not the expanded view. @param {import('@playwright/test').Page} page */
export async function noSideways(page, where) {
  const over = await page.evaluate(() => {
    const out = [];
    const d = document.documentElement;
    if (d.scrollWidth > innerWidth + 1) out.push(`the page by ${d.scrollWidth - innerWidth} px`);
    for (const sel of ['.wp-body', '.sp-body', '.rpane', '.pane-full']) {
      const el = document.querySelector(sel);
      if (el && el.scrollWidth > el.clientWidth + 1) out.push(`${sel} by ${el.scrollWidth - el.clientWidth} px`);
    }
    return out;
  });
  expect(over, `scrolls sideways ${where}`).toEqual([]);
}
