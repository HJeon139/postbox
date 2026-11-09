// Leaving a room lets its page go (#866, hotfix 3). Holders of drawn elements kept a reference to elements that had left
// the page, and one such element keeps its whole old page alive through its parents: each trip into a long room and
// back kept one more copy of it (in the person’s Firefox, about 700 MB a trip). Chromium counts the live DOM nodes
// (the DevTools protocol’s Memory.getDOMCounters) after a forced garbage collection: from the second visit to a long
// room on, they hold steady, with no client change between the switches for a lazy holder to hear.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, newestShown, openAs, ROOM_MODES, startPostbox, synced } from './postbox.mjs';

test.use({ colorScheme: 'light', trace: 'off' });

const ITEMS = 600;
const ROUNDS = 4;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('page-leak');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);
// In both ROOM_MODES (#866): with the window on, as a long room opens by default, and whole, as a room at or under
// the window’s ceiling mounts, so a leak on either path fails.

/**
 * A long room and a short one in the same project, with the same three agents in each.
 * @param {{ diagrams?: number, review?: boolean }} [opts] how many of the long room’s replies end in a Mermaid diagram,
 *   and whether it ends in a review with a comment on a selection
 */
function rooms({ diagrams = 0, review = false } = {}) {
  const { rt, store } = app;
  const projectId = /** @type {any} */ (Object.values(store.state.projects)[0]).id;
  const personas = ['ada', 'bo', 'cy'].map((handle) => rt.personaByHandle(handle) ?? rt.createPersona({ handle }));
  const long = rt.createThread({ projectId, title: 'A long room', personaIds: personas.map((p) => p.id) });
  const short = rt.createThread({ projectId, title: 'A short room', personaIds: personas.map((p) => p.id) });
  const sessions = Object.fromEntries(rt.sessionsIn(long.id).map((se) => [se.handle, { sessionId: se.id, personaId: se.personaId }]));
  // The big room’s replies are from researcher, critic and developer: give each one of these agents’ sessions.
  const [a, b, c] = Object.values(sessions);
  seedBigRoom(store, long.id, { count: ITEMS, diagrams }, { researcher: a, critic: b, developer: c });
  if (review) {
    const [author, reader] = rt.sessionsIn(long.id);
    const content = '# A draft\n\nIts price is low, and its plan is short.\n';
    rt.toolsFor(author.id).show_block({
      block: { id: 'draft', type: 'review', version: 1, title: 'A draft', fallback: 'A draft', format: 'markdown', content },
    });
    const said = rt
      .toolsFor(reader.id)
      .review_block({ blockId: 'draft', comments: [{ line: 3, col: 14, endLine: 3, endCol: 16, quote: 'low', text: 'How low?' }] });
    if (!said.ok) throw new Error(`The reader couldn’t comment: ${said.message}`);
  }
  for (const se of rt.sessionsIn(short.id))
    rt.addItem(short.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: `A reply from ${se.handle}.`, status: 'done' });
  return { long, short };
}

/** Goes to a conversation by its address and waits for its transcript to hold every item. */
async function open(page, thread) {
  await page.evaluate((id) => {
    location.hash = `#/t/${id}`;
  }, thread.id);
  await newestShown(page, app, thread.id);
}

/** The live DOM nodes, after two forced garbage collections. */
async function liveNodes(cdp) {
  for (let i = 0; i < 2; i++) await cdp.send('HeapProfiler.collectGarbage');
  return (await cdp.send('Memory.getDOMCounters')).nodes;
}

// A room with diagrams too (#945): each diagram’s frame is lazy, so one far up the room never loads, and its
// listener had kept its frame, and so its page, until it had once been seen on the page. And one ending in a review
// with a comment on a selection: its marked ranges (review-preview.mjs) were let go of only past 50 reviews.
for (const mode of ROOM_MODES)
  for (const [what, diagrams, review] of /** @type {const} */ ([
    ['', 0, false],
    [' with diagrams', 12, false],
    [' with a review whose comment marks its text', 0, true],
  ]))
    test(`#866 a trip into a long room${what} and back keeps no copy of its page, ${mode}`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'the node count comes from Chromium’s DevTools protocol');
      test.setTimeout(120_000);
      await openAs(page, mode);
      const { long, short } = rooms({ diagrams, review });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${app.origin}/#/t/${short.id}`);
      await synced(page, app);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('HeapProfiler.enable');
      const atLong = [];
      const atShort = [];
      for (let r = 0; r < ROUNDS; r++) {
        await open(page, long);
        atLong.push(await liveNodes(cdp));
        await open(page, short);
        // A frame for what the page lets go on its next frame after a switch (review-preview.mjs’s marks).
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        atShort.push(await liveNodes(cdp));
      }
      const page1 = await page.evaluate(() => document.getElementsByTagName('*').length);
      test.info().annotations.push({
        type: 'measured',
        description: `live nodes at the long room, each visit: ${atLong.join(', ')}; back in the short room: ${atShort.join(', ')}; the short room’s page: ${page1} elements`,
      });
      // One copy of the long room’s page is about atLong[0] nodes. Kept, each visit adds one; let go, the count holds.
      const growth = /** @type {number} */ (atLong.at(-1)) - /** @type {number} */ (atLong[1]);
      expect(growth, `live nodes, visit by visit: ${atLong.join(', ')}`).toBeLessThan(atLong[0] * 0.1);
      // Back in the short room, the long room’s page is let go too, not held until the next visit replaces it. What
      // lets go a frame after the switch (review-preview.mjs’s marks) can still be running when the last count is taken
      // (1 run in 60 on the Mac, window on), so the count is read again until it drops; a page that’s kept never does.
      await expect
        .poll(() => liveNodes(cdp), { message: `live nodes back in the short room: ${atShort.join(', ')}`, timeout: 5000 })
        .toBeLessThan(atLong[0] * 0.5);
    });

// From a room to the project’s Threads page (#945): the page let the room’s column go only once another room was
// drawn (main.mjs, `conversation`), so the Threads page kept the whole long room alive.
for (const mode of ROOM_MODES)
  test(`#866 the Threads page keeps no copy of the long room you came from, ${mode}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the node count comes from Chromium’s DevTools protocol');
    test.setTimeout(120_000);
    await openAs(page, mode);
    const { long, short } = rooms();
    const projectId = /** @type {any} */ (Object.values(app.store.state.projects)[0]).id;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${app.origin}/#/t/${short.id}`);
    await synced(page, app);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    const threadsAfter = async (room) => {
      await open(page, room);
      const atRoom = await liveNodes(cdp);
      await page.evaluate((id) => {
        location.hash = `#/p/${id}/threads`;
      }, projectId);
      await expect(page.locator('#root .main')).toBeVisible();
      await expect(page.locator('.transcript')).toHaveCount(0);
      return { atRoom, atThreads: await liveNodes(cdp) };
    };
    const fromShort = await threadsAfter(short);
    const fromLong = await threadsAfter(long);
    test.info().annotations.push({ type: 'measured', description: JSON.stringify({ fromShort, fromLong }) });
    // Kept, the Threads page after the long room holds about that room’s nodes more than after the short one.
    expect(fromLong.atThreads - fromShort.atThreads, `live nodes at Threads: ${JSON.stringify({ fromShort, fromLong })}`).toBeLessThan(
      (fromLong.atRoom - fromShort.atRoom) * 0.1,
    );
  });
