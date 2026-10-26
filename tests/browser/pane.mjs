// What the right pane’s specs share (pane-width, pane-handle, telemetry): a Postbox whose demo “Citation fixes” has
// replies, an app and a topic thread, a window of a given width with nothing kept from before, and the layout as a
// person sees it.

import { expect } from '@playwright/test';
import { settled, startPostbox, synced } from './postbox.mjs';

/** The conversation column’s minimum, and its composer’s text box at that width (architecture.md, §14). */
export const COL_MIN = 640;
export const BOX_MIN = 430;
export const WORK = 'aside.workpane';
export const THREAD = 'aside.sidepanel';

/**
 * Starts a spec’s Postbox and seeds “Citation fixes”: four questions and long answers, an app, and a topic thread from
 * the first answer. ids holds it, its topic thread, and another conversation; conv() is its address with a pane part.
 * @param {string} name
 */
export async function paneRoom(name) {
  const app = await startPostbox(name);
  const { rt, store } = app;
  const c = Object.values(store.state.threads).find((t) => t.title === 'Citation fixes');
  const [se] = rt.sessionsIn(c.id);
  const say = (text) => rt.addItem(c.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  for (let i = 1; i <= 4; i++) {
    rt.addItem(c.id, { kind: 'user', text: `Question ${i}: which citations does the script still miss?` });
    say(`Answer ${i}: ${'The parser drops entries whose year sits in a note field, so the list comes up short. '.repeat(3)}`);
  }
  rt.toolsFor(se.id).show_app({
    id: 'explorer',
    title: 'Explorer',
    fallback: 'Explorer: a box as wide as its frame.',
    code: '<div style="height:200px;border:1px solid">An explorer</div>',
  });
  const root = store.items(c.id).find((i) => i.kind === 'agent');
  const ids = {
    conv: c.id,
    topic: rt.startTopic(c.id, root.id).threadId,
    other: Object.values(store.state.threads).find((t) => t.title === 'Agent memory papers').id,
  };
  return { app, ids, conv: (r) => `#/t/${ids.conv}${r}` };
}

/**
 * Opens the conversation alone in a window this wide, with the sidebar open, or hidden as the person left it.
 * @param {import('@playwright/test').Page} page  @param {Awaited<ReturnType<typeof paneRoom>>} room
 * @param {number} width  @param {{ height?: number, railHidden?: boolean, at?: string }} [options]
 */
export async function fresh(page, room, width, { height = 800, railHidden = false, at = '' } = {}) {
  await page.setViewportSize({ width, height });
  if (railHidden)
    // In the page only: it runs in every frame, and a sandboxed app’s has no storage.
    await page.addInitScript(() => {
      if (window === window.top) localStorage.setItem('pb-rail', 'hidden');
    });
  await page.goto(`${room.app.origin}/${room.conv(at)}`);
  await synced(page, room.app);
  await expect(page.locator('.composer textarea').first()).toBeVisible();
  await settled(page);
}

/** Goes to an address in the same page, as the app’s links do, once the page has heard everything the server did. */
export async function go(page, room, to) {
  await synced(page, room.app);
  await page.evaluate((h) => {
    location.hash = h;
  }, to);
  await expect(page.locator('header.topbar')).toBeVisible();
  await settled(page);
}

/** The layout as a person sees it: the column, a reply, the composer’s text box, the pane, and full screen. */
export const measure = (page) =>
  page.evaluate(() => {
    const w = (sel) => {
      const el = document.querySelector(sel);
      return el?.getClientRects().length ? Math.round(el.getBoundingClientRect().width) : 0;
    };
    const reply = Math.max(0, ...[...document.querySelectorAll('.transcript .md')].map((el) => Math.round(el.getBoundingClientRect().width)));
    return {
      main: w('.main'),
      reply,
      box: w('.composer textarea'),
      pane: w('.rpane'),
      rail: w('.rail'),
      app: w('.transcript .appframe'),
      auto: !!document.querySelector('.app.rail-auto'),
      toggle: document.getElementById('rail-toggle')?.getAttribute('aria-label'),
      full: !!document.querySelector('.pane-full'),
      focusIn: !!document.activeElement?.closest('.pane-full'),
    };
  });
