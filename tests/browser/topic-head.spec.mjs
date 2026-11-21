// #551: a topic thread’s head wrapped a long conversation name one word per line, beside Summarize back and Copy link,
// and pushed the thread out of view. The head’s title and its “in <conversation>” line are now one line each, cut with
// an ellipsis as the top bar cuts a name: at the window the issue was seen in, with Work open, and for a side thread
// with a long title of its own in a phone-width window. However narrow the panel, enough of each line shows to read,
// and each has its whole text on hover.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('topic-head');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

// The issue’s name, at Rename’s 120-character cap.
const NAME = 'A very long room name that keeps going and going to see whether the top bar, rail, document title, breadcrumbs and menus';
let n = 0;

/** A conversation with that name, and a topic thread from a message in it, or a side thread with a long title. */
function threadIn(kind) {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: NAME, personaIds: [arrange.persona(rt, 'librarian').id] });
  if (kind === 'topic') {
    const root = arrange.post(rt, t.id, { kind: 'user', text: 'Start a thread from here.' });
    return { t, side: rt.startTopic(t.id, root.id).threadId, title: 'Thread', sub: `in ${NAME}` };
  }
  const title = `librarian ↔ indexer about ${NAME}`;
  const base = { id: `th_head${++n}`, projectId, title, kind: 'side', parentId: t.id, pair: 'indexer|librarian', woke: 'indexer' };
  arrange.putThread(rt, { ...base, members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: Date.now() });
  return { t, side: base.id, title, sub: `Side thread from ${NAME}` };
}

/** How many lines an element takes, and whether its text is cut with an ellipsis. */
const shape = (locator) =>
  locator.evaluate((el) => ({
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    cut: el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis',
  }));

for (const [kind, width, work, paneMin] of [
  ['topic', 1024, false, false],
  ['topic', 1024, true, false],
  ['topic', 1280, false, false],
  ['side', 375, false, false],
  ['topic', 320, false, false],
  ['side', 1024, false, true],
]) {
  test(`#551 a ${kind} thread’s head keeps its lines to one each at ${width} px${work ? ', with Work open' : ''}${paneMin ? ', the pane at its narrowest' : ''}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 768 });
    const { t, side, title, sub } = threadIn(kind);
    await page.goto(`${app.origin}/#/t/${t.id}/side/${side}${work ? '?work' : ''}`);
    await synced(page, app);
    if (paneMin) {
      // Home takes the pane to its narrowest, PANE_MIN (pane-width.mjs).
      await page.getByRole('separator', { name: 'Resize the pane' }).focus();
      await page.keyboard.press('Home');
    }
    const head = page.locator('aside.sidepanel .sp-head');
    const name = head.locator('#sp-title');
    const where = head.locator('#sp-title + div');
    await expect(name).toHaveText(title);
    await expect(where).toHaveText(sub);
    expect(await shape(where), 'the conversation it’s in: one line, cut').toEqual({ lines: 1, cut: true });
    if (kind === 'side') expect(await shape(name), 'a long title: one line, cut').toEqual({ lines: 1, cut: true });
    // Enough of each line shows to read it, “Thread” or a few words and an ellipsis, however narrow the panel.
    for (const [line, what] of [
      [name, 'its title'],
      [where, 'the conversation it’s in'],
    ]) {
      expect((await line.boundingBox())?.width ?? 0, `${what}: wide enough to read`).toBeGreaterThanOrEqual(48);
      // “Thread” is never cut, so it needs no title.
      if (line === where || kind === 'side') await expect(line, `${what}: whole on hover`).toHaveAttribute('title', (await line.textContent()) ?? '');
    }
    const spill = await head.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('button')]
        .filter((b) => b.getBoundingClientRect().right > box.right + 0.5)
        .map((b) => b.textContent || b.getAttribute('aria-label'));
    });
    expect(spill, 'every button inside the head').toEqual([]);
    // With room, one row, as main draws it.
    if (width >= 1280) expect((await head.boundingBox())?.height, 'the head stays the height of one row of buttons').toBeLessThan(80);
  });
}
