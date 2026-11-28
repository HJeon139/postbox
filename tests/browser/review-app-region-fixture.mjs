// The shared setup of the #856 region specs: a Postbox with a mock agent, and a room with an app and a review of it,
// open on the page, and how to drag across the layer Postbox draws over the app and where a drawn region sits.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// An app that names no parts, tall enough to drag across.
export const BARE = '<main style="height:320px;padding:12px;color:var(--text)"><h2>Corpus summary</h2><p>Twelve books.</p></main>';

/**
 * A Postbox for one spec file, started before its tests and stopped after them, and the review rooms it opens.
 * @param {string} name  the spec’s, for its data folder
 */
export function regionRoom(name) {
  /** @type {Awaited<ReturnType<typeof startPostbox>>} */
  let app;
  /** What the agents were sent. */
  const calls = [];
  test.beforeAll(async () => {
    app = await startPostbox(name);
    arrange.withAdapter(app.rt, {
      name: 'mock',
      async deliver(_session, message) {
        calls.push(message);
      },
    });
  });
  test.afterAll(async () => {
    await app?.stop();
  });
  failOnPageErrors(test);

  let rooms = 0;
  /** A room with an app and a review of it, open on the page once the app has passed its check. */
  async function review(page, extra = {}, code = BARE) {
    const { rt, store } = app;
    const n = ++rooms;
    const thread = rt.createThread({
      projectId: Object.values(store.state.projects)[0].id,
      title: `Region ${n}`,
      personaIds: [arrange.persona(rt, 'researcher').id],
    });
    const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
    const id = `region-app-${n}`;
    tools.show_app({ id, title: 'Corpus summary', code });
    const blockId = `rv-region-${n}`;
    const shown = tools.show_block({ block: { id: blockId, type: 'review', version: 1, fallback: 'Review the app', format: 'app', appId: id, ...extra } });
    if (!shown.ok) throw new Error(shown.message);
    if (page.url().startsWith(app.origin)) await synced(page, app);
    await page.goto(`${app.origin}/#/t/${thread.id}`);
    await synced(page, app);
    await expect.poll(() => rt.store.state.apps[id].check.status, { message: 'the app passes its check', timeout: 15_000 }).toBe('passed');
    await synced(page, app);
    const item = store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === blockId);
    const block = page.locator(`#main [data-key="${item.id}"]`);
    await expect(block.locator('iframe.app-iframe'), 'the review draws the app').toHaveCount(1);
    await expect(block.locator('.app-body > .rv-marks'), 'with Postbox’s layer over its frame').toHaveCount(1);
    const answer = () => calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments;
    /** The review’s agent updates it, with these fields over the block as shown. */
    const update = (/** @type {Record<string, any>} */ fields) => {
      const r = tools.update_block({ block: { ...store.item(thread.id, item.id).block, ...fields } });
      if (!r.ok) throw new Error(r.message);
    };
    return { block, answer, update, item: () => store.item(thread.id, item.id) };
  }

  return {
    get app() {
      return app;
    },
    review,
  };
}

/**
 * Drags across the layer over the app, from one point to another, each as fractions of its width and height, and ends
 * nudge pixels further each way, as a hand does.
 */
export async function drag(page, block, from, to, nudge = 0) {
  const layer = block.locator('.rv-marks.marking');
  // Centered, so no part of it sits under the sticky top bar, which a narrow window leaves over the top of the view.
  await layer.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const r = await layer.boundingBox();
  if (!r) throw new Error('The layer over the app has no box.');
  await page.mouse.move(r.x + r.width * from[0], r.y + r.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * to[0] + nudge, r.y + r.height * to[1] + nudge, { steps: 6 });
  await page.mouse.up();
}

/** The size of a review’s app frame, in CSS px, as a region records it. */
export const frameSize = (block) => block.locator('iframe.app-iframe').evaluate((f) => ({ width: f.clientWidth, height: f.clientHeight }));

/** A region, kept in px of the app (#856), as fractions of the frame it was marked in, to compare across sizes. */
export const fractions = (r) => ({ x: r.x / r.width, y: r.y / r.height, w: r.w / r.width, h: r.h / r.height, version: r.version });

/** A region in px of a frame this size, from fractions of it: what an agent writes for a place it means. */
export const regionIn = (size, f) => ({
  x: Math.round(f.x * size.width),
  y: Math.round(f.y * size.height),
  w: Math.round(f.w * size.width),
  h: Math.round(f.h * size.height),
  ...size,
  version: f.version,
});

/** What a region’s place reads as, on the page and to the agent, in px of a frame. */
export const PLACE = String.raw`x \d+, y \d+, \d+ × \d+ px, on v1, in a \d+ × \d+ px frame`;

/** Whether a region, as fractions of its frame, is about where it should be: within 2% of the app each way, on its version. */
export const within = (got, want) => Object.keys(want).every((k) => Math.abs(got?.[k] - want[k]) <= (k === 'version' ? 0 : 0.02));

/** Where a drawn region is, as fractions of the app’s frame. */
export const drawnAt = (drawn) =>
  drawn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const f = el.closest('.app-body')?.querySelector('iframe')?.getBoundingClientRect();
    if (!f) throw new Error('The region isn’t over an app’s frame.');
    return { x: (r.left - f.left) / f.width, y: (r.top - f.top) / f.height, w: r.width / f.width, h: r.height / f.height, version: 1 };
  });
