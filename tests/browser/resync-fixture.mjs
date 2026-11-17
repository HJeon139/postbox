// What the resync specs share (#987): a room with apps open on the page, marks on its nodes and frames, what a resync
// kept of them, and a page made to miss the server’s events, as a sleeping laptop’s does.

import { expect } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { newestShown, settled, synced } from './postbox.mjs';

export const BODY = (n) => `<main style="padding:12px"><p>App ${n}</p><button type="button">Go</button></main>`;

/**
 * A room of `messages` messages, then `apps` apps, open on the page, each app checked there and sized; returns the
 * room and its agent’s tools. @param {any} app  the running Postbox @param {import('@playwright/test').Page} page
 */
export async function room(app, page, title, messages, apps) {
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title,
    personaIds: [arrange.persona(rt, 'librarian').id],
  });
  for (let i = 0; i < messages; i++) arrange.post(rt, t.id, { kind: 'user', text: `Message ${i}` });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const ids = [];
  for (let i = 0; i < apps; i++) {
    const id = `app${i}-${t.id}`;
    tools.show_app({ id, title: `App ${i}`, code: BODY(i), permissions: [] });
    await expect.poll(() => rt.store.state.apps[id]?.check.status).toMatch(/^(passed|note)$/);
    ids.push(id);
  }
  await synced(page, app);
  await newestShown(page, app, t.id);
  await expect(page.locator('#main iframe.app-iframe[data-sized="1"]')).toHaveCount(apps);
  await settled(page);
  return { t, tools, ids };
}

/** Marks every item node and app frame on the page, and counts each frame’s loads from now on. */
export const mark = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.frameLoads = 0;
    w.keysBefore = [];
    for (const n of document.querySelectorAll('#main > .item')) {
      /** @type {any} */ (n).kept = true;
      w.keysBefore.push(/** @type {HTMLElement} */ (n).dataset.key);
    }
    for (const f of document.querySelectorAll('#main iframe.app-iframe')) {
      /** @type {any} */ (f).kept = true;
      f.addEventListener('load', () => w.frameLoads++);
    }
    return document.querySelectorAll('#main iframe.app-iframe').length;
  });

/**
 * What’s on the page now: the item nodes and frames, the items that were on the page before and have a new node, the
 * new frames, and the marked frames’ loads. A window may mount a few more or fewer items around where you are.
 */
export const seen = (page) =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('#main > .item')];
    const frames = [...document.querySelectorAll('#main iframe.app-iframe')];
    return {
      items: items.length,
      newItems: items
        .filter((n) => !(/** @type {any} */ (n).kept) && /** @type {any} */ (window).keysBefore.includes(/** @type {HTMLElement} */ (n).dataset.key))
        .map((n) => /** @type {HTMLElement} */ (n).dataset.key),
      frames: frames.length,
      newFrames: frames.filter((f) => !(/** @type {any} */ (f).kept)).map((f) => f.title),
      newApps: items
        .filter(
          (n) =>
            n.querySelector('.app-holder') &&
            !(/** @type {any} */ (n).kept) &&
            /** @type {any} */ (window).keysBefore.includes(/** @type {HTMLElement} */ (n).dataset.key),
        )
        .map((n) => /** @type {HTMLElement} */ (n).dataset.key),
      loads: /** @type {any} */ (window).frameLoads,
    };
  });

/** Stops the page hearing the server’s events, as a sleeping laptop’s does; returns the page’s resync. @param {any} app */
export async function away(app, page) {
  await page.route('**/api/stream*', (r) => r.fulfill({ status: 204 }));
  await page.evaluate(() => import('/app/js/client.mjs').then(({ connect }) => connect({ quiet: true })));
  return async () => {
    await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
    await page.unroute('**/api/stream*');
    await page.evaluate(() => import('/app/js/client.mjs').then(({ connect }) => connect({ quiet: true })));
    await synced(page, app);
    await settled(page);
  };
}

/** The keys of the transcript’s items, in the page’s order. @param {import('@playwright/test').Page} page */
export const order = (page) => page.evaluate(() => [...document.querySelectorAll('#main > .item')].map((n) => /** @type {HTMLElement} */ (n).dataset.key));
