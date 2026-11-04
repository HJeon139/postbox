// What view-read.spec.mjs and view-anchor.spec.mjs share (#531, B1b-a): a long room, opening it, and V1's check that the
// transcript's data-view-* say what the page shows. Following means at the end; reading means the named item starts
// that far down the view, within 1 px.

import { expect } from '@playwright/test';
import { settled, synced } from './postbox.mjs';

export const LONG = (/** @type {number} */ n) =>
  `Reply ${n}. The observation is the only outside evidence in the loop, so it keeps the plan grounded while the agent reads the results one at a time.`;

/** A long room with @researcher, and a way for it to say more. @param {any} app @param {string} title */
export function room(app, title) {
  const { rt, store } = app;
  const project = /** @type {any} */ (Object.values(store.state.projects)[0]);
  const t = rt.createThread({ projectId: project.id, title, personaIds: [rt.personaByHandle('researcher').id] });
  const [se] = rt.sessionsIn(t.id);
  const say = (/** @type {string} */ text) =>
    rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  for (let i = 1; i <= 30; i++) {
    if (i % 3 === 1) rt.addItem(t.id, { kind: 'user', text: `Question ${i}?` });
    else say(LONG(i));
  }
  return { t, say };
}

/** @param {any} app @param {any} page @param {any} t */
export async function open(app, page, t, width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] .item`).first()).toBeVisible();
  await settled(page);
}

/** What the transcript publishes, and what the page shows: the gap to the end, and where the named item really starts. */
export const read = (/** @type {any} */ page, /** @type {any} */ t) =>
  page.evaluate((/** @type {string} */ threadId) => {
    const el = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript[data-thread="${threadId}"]`));
    const s = /** @type {Element} */ (document.scrollingElement);
    const { viewMode: mode, viewAnchor: anchor, viewOffset: offset } = el.dataset;
    const n = anchor ? el.querySelector(`:scope > [data-key="${CSS.escape(anchor)}"]`) : null;
    return { mode, anchor, offset, gap: s.scrollHeight - s.scrollTop - s.clientHeight, actual: n ? n.getBoundingClientRect().top : null };
  }, t.id);

/** V1: the attributes say what the page shows. @param {any} page @param {any} t @param {string} label */
export async function holds(page, t, label) {
  const v = await read(page, t);
  if (v.mode === 'following') {
    expect(v.gap, `${label}: following is at the end`).toBeLessThanOrEqual(2);
    expect([v.anchor, v.offset], `${label}: no anchor while following`).toEqual(['', '']);
    return v;
  }
  expect(v.mode, label).toBe('reading');
  expect(v.actual, `${label}: the anchor ${v.anchor} is on the page`).not.toBeNull();
  expect(Math.abs(/** @type {number} */ (v.actual) - Number(v.offset)), `${label}: the anchor starts where it says`).toBeLessThanOrEqual(1);
  return v;
}
