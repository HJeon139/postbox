// The page measures under the pointer only when an app could be under it (#930). Apps take no pointer events until
// the page sees the pointer over one (#38), so the page looks again for the frame under a resting pointer whenever
// the page changes. That look is an elementFromPoint and a getBoundingClientRect, a layout of the whole page: it ran
// once a frame with any change on the page, with no app anywhere near the view, or none in the room at all. In the
// person’s Firefox profile, 488 forced layouts and 1.52 s in it.
//
// An init script counts Document.prototype.elementFromPoint calls while 50 changes stream into the transcript, one
// a frame, under a resting pointer: none when no app is near the view, and none in a room with no apps. Then what
// must still hold: an app scrolled in from far away, and an app review, each become live under a resting pointer.
// An app in the transcript moving under a resting pointer is #38’s, in app-send.spec.mjs.

import { expect, test } from '@playwright/test';
import { frameOf } from './app-pointer.mjs';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

const BATCHES = 50;
const TALL = '<main style="padding:12px"><button id="b" type="button" style="display:block;width:100%;height:160px">Big</button></main>';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-pointer-cost');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const look = Document.prototype.elementFromPoint;
    /** @type {any} */ (window).pbLooks = 0;
    Document.prototype.elementFromPoint = function (...args) {
      /** @type {any} */ (window).pbLooks++;
      return look.apply(this, args);
    };
  });
});

/** A room of its own, open in the page, with @librarian to show apps. */
async function room(page, title) {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [rt.personaByHandle('librarian').id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const lines = async (n, what) => {
    for (let i = 1; i <= n; i++)
      rt.addItem(t.id, { kind: 'user', text: `${what} ${i}: a line to give the page some length, long enough to wrap in a narrow window.` });
    await synced(page, app);
  };
  /** Shows an app named for this room, and waits for it to pass its check and load. */
  const show = async (title) => {
    const id = `${title.toLowerCase().replace(/\W+/g, '-')}-${t.id}`;
    tools.show_app({ id, title, code: TALL, permissions: [] });
    await expect.poll(() => rt.s.apps[id]?.check.status, { message: `${title} to pass its check` }).toMatch(/^(passed|note)$/);
    await expect(frameOf(page, title), `${title} to load`).toHaveAttribute('data-sized', '1');
    return id;
  };
  return { t, tools, lines, show };
}

/** Rests the pointer in the middle of the window, over the transcript, then streams BATCHES changes, one a frame. */
async function looksWhileStreaming(page) {
  const size = /** @type {{ width: number, height: number }} */ (page.viewportSize());
  await page.mouse.move(size.width / 2, size.height / 2);
  await settled(page);
  return page.evaluate(async (n) => {
    const w = /** @type {any} */ (window);
    const last = /** @type {HTMLElement} */ ([...document.querySelectorAll('#main > .item')].at(-1));
    const before = w.pbLooks;
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      last.append(document.createTextNode(` ${i}`));
    }
    // Two frames more, for a look the last change asked for.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return w.pbLooks - before;
  }, BATCHES);
}

/** An app far off screen, unloaded, scrolled back under a resting pointer: it reloads and becomes live. */
async function scrolledIn(page, width) {
  const r = await room(page, `Scrolled in ${width}`);
  await r.lines(4, 'Before');
  const title = `Coming ${width}`;
  await r.show(title);
  await r.lines(80, 'After');
  await settled(page);
  await expect(page.locator('.app-body .app-placeholder', { hasText: 'Unloaded while off screen' })).toHaveCount(1);
  const size = /** @type {{ width: number, height: number }} */ (page.viewportSize());
  const rest = { x: size.width / 2, y: size.height / 2 };
  await page.mouse.move(rest.x, rest.y);
  await settled(page);
  // The page jumps to put the app’s body under the pointer, as a jump back up the conversation does.
  await page.locator('.app-body').evaluate((body, y) => scrollBy(0, body.getBoundingClientRect().top + 40 - y), rest.y);
  const f = frameOf(page, title);
  await expect(f, 'reloaded as it came near').toHaveAttribute('data-sized', '1');
  await settled(page);
  const under = await f.evaluate((n, at) => {
    const b = n.getBoundingClientRect();
    return b.top <= at.y && at.y < b.bottom && b.left <= at.x && at.x < b.right;
  }, rest);
  expect(under, 'the app is under the pointer').toBe(true);
  await expect(f, 'live under the resting pointer').toHaveClass(/\blive\b/);
}

/** An app review (not watched for nearness, as it never unloads) scrolls under a resting pointer and becomes live. */
async function reviewGoesLive(page, width) {
  const r = await room(page, `Review ${width}`);
  const title = `Reviewed ${width}`;
  const appId = await r.show(title);
  // The app’s own item far above, unloaded, so only the review’s frame is near the view.
  await r.lines(80, 'Between');
  r.tools.show_block({ block: { id: `rv-${width}`, type: 'review', version: 1, title, fallback: 'Review the app.', format: 'app', appId } });
  await r.lines(6, 'After');
  const f = page.locator('.rv-box iframe.app-iframe');
  await expect(f, 'the review’s app to load').toHaveAttribute('data-sized', '1');
  await expect(page.locator('.app-holder .app-placeholder', { hasText: 'Unloaded while off screen' }), 'the app’s own item unloaded').toHaveCount(1);
  const SHIFT = 120;
  await f.evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await settled(page);
  const b = /** @type {{ x: number, y: number, width: number }} */ (await f.boundingBox());
  const rest = { x: b.x + b.width / 2, y: b.y + 40 - SHIFT };
  await page.mouse.move(rest.x, rest.y);
  await frames(page);
  await expect(f, 'over the page, not the app, to begin with').not.toHaveClass(/\blive\b/);
  await page.evaluate((shift) => scrollBy(0, shift), SHIFT);
  await settled(page);
  const under = await f.evaluate((n, y) => {
    const box = n.getBoundingClientRect();
    return box.top <= y && y < box.bottom;
  }, rest.y);
  expect(under, 'the review’s app moved under the pointer').toBe(true);
  await expect(f, 'live under the resting pointer').toHaveClass(/\blive\b/);
}

/**
 * critic’s read of #930: an app review renders a new body each time it re-renders (a comment, an answer), and the
 * bodies it left behind stayed in the near set until the whole transcript went, so the page kept looking under the
 * pointer. Here a review is shown, re-rendered twice, answered, and moved far off screen.
 */
async function staleReviewLooks(page, width) {
  const r = await room(page, `Stale review ${width}`);
  const title = `Stale ${width}`;
  const appId = await r.show(title);
  const block = (version) => ({ id: `srv-${width}`, type: 'review', version, title, fallback: 'Review the app.', format: 'app', appId });
  r.tools.show_block({ block: block(1) });
  const f = page.locator('.rv-box iframe.app-iframe');
  await expect(f, 'the review’s app to load').toHaveAttribute('data-sized', '1');
  for (const version of [2, 3]) {
    r.tools.update_block({ block: block(version) });
    await synced(page, app);
    await expect(f).toHaveAttribute('data-sized', '1');
  }
  const it = app.store.items(r.t.id).find((i) => i.kind === 'block' && i.block.type === 'review');
  await app.rt.act(r.t.id, it.id, 'submit', { verdict: 'approve', comments: [] }, it.revision ?? 1);
  await synced(page, app);
  await r.lines(80, 'After');
  await settled(page);
  // Far below both apps’ bodies, past the near margin (one and a half windows): nothing on the page is near the view.
  const below = await page.locator('.app-body').evaluateAll((bodies) => bodies.every((b) => b.getBoundingClientRect().bottom < -1.5 * innerHeight));
  expect(below, 'every app body is far above the view').toBe(true);
  const looks = await looksWhileStreaming(page);
  test.info().annotations.push({ type: 'measured', description: `elementFromPoint calls: ${looks}` });
  expect(looks, 'looks under the pointer after an answered app review left the view').toBe(0);
}

for (const width of [375, 1280])
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test(`#930 ${BATCHES} changes under a resting pointer, one a frame, with an app far off screen, look for no app frame`, async ({ page }) => {
      const r = await room(page, `Far app ${width}`);
      await r.show(`Far ${width}`);
      await r.lines(80, 'After');
      await settled(page);
      // Far off screen, it unloads: the page has heard it’s not near the view.
      await expect(page.locator('.app-body .app-placeholder', { hasText: 'Unloaded while off screen' })).toHaveCount(1);
      const looks = await looksWhileStreaming(page);
      test.info().annotations.push({ type: 'measured', description: `elementFromPoint calls: ${looks}` });
      expect(looks, 'looks under the pointer while no app is near the view').toBe(0);
    });

    test(`#930 ${BATCHES} changes under a resting pointer, one a frame, in a room with no apps, look for no app frame`, async ({ page }) => {
      const r = await room(page, `No apps ${width}`);
      await r.lines(30, 'Line');
      await settled(page);
      const looks = await looksWhileStreaming(page);
      test.info().annotations.push({ type: 'measured', description: `elementFromPoint calls: ${looks}` });
      expect(looks, 'looks under the pointer in a room with no apps').toBe(0);
    });

    test('#930 an app scrolled in from far away becomes live under the resting pointer', ({ page }) => scrolledIn(page, width));

    test('#930 an app review in view becomes live when it scrolls under the resting pointer', ({ page }) => reviewGoesLive(page, width));

    test('#930 a re-rendered, answered app review far off screen leaves no look under the pointer', ({ page }) => staleReviewLooks(page, width));
  });
