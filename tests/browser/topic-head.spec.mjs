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

/**
 * The head’s rows: its height, the row each button is on, and where its last button (Close) ends. A label that changes
 * width moves the buttons beside it along their row, as any label does; it must not move one to another row.
 */
const layout = (head) =>
  head.evaluate((el) => {
    const buttons = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
    return {
      height: Math.round(el.getBoundingClientRect().height),
      rows: buttons.map((r) => Math.round(r.top)),
      closeRight: Math.round(buttons.at(-1)?.right ?? 0),
    };
  });

/** Sets a head button’s label, as Summarize back and Copy link do while a summary is asked for or a link is copied. */
const relabel = (head, from, to) =>
  head.evaluate(
    (el, [a, b]) => {
      const btn = [...el.querySelectorAll('button')].find((x) => x.textContent?.trim() === a);
      if (btn) btn.textContent = b;
      return !!btn;
    },
    [from, to],
  );

for (const [width, paneMin] of [
  [1024, false],
  [1024, true],
]) {
  test(`#551 “Summary requested…” and “Copied” move no button in the head at ${width} px${paneMin ? ', the pane at its narrowest' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 768 });
    const { t, side } = threadIn('topic');
    await page.goto(`${app.origin}/#/t/${t.id}/side/${side}`);
    await synced(page, app);
    if (paneMin) {
      await page.getByRole('separator', { name: 'Resize the pane' }).focus();
      await page.keyboard.press('Home');
    }
    const head = page.locator('aside.sidepanel .sp-head');
    await expect(head.locator('#sp-title')).toHaveText('Thread');
    const still = await layout(head);
    // Wrapped or not, the buttons are kept right: Close ends at the head’s right edge, inside its padding.
    const edge = await head.evaluate((el) => Math.round(el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight)));
    expect(still.closeRight, 'Close kept right').toBe(edge);
    expect(await relabel(head, 'Summarize back', 'Summary requested…')).toBe(true);
    expect(await layout(head), 'with “Summary requested…”').toEqual(still);
    expect(await relabel(head, 'Copy link', 'Copied')).toBe(true);
    expect(await layout(head), 'and “Copied”').toEqual(still);
    expect(await relabel(head, 'Summary requested…', 'Summarize back')).toBe(true);
    expect(await layout(head), 'and back').toEqual(still);
  });
}

test('#551 across head widths, the widest labels move no button across rows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 768 });
  const { t, side } = threadIn('topic');
  await page.goto(`${app.origin}/#/t/${t.id}/side/${side}`);
  await synced(page, app);
  const head = page.locator('aside.sidepanel .sp-head');
  await expect(head.locator('#sp-title')).toHaveText('Thread');
  const moved = [];
  // Each head width from the narrowest panel, 320 px (PANE_MIN, and the narrowest window), to 480, set on the head itself.
  for (let w = 320; w <= 480; w += 2) {
    await head.evaluate((el, px) => {
      el.style.flex = 'none';
      el.style.width = `${px}px`;
    }, w);
    const plain = await layout(head);
    // “Summary requested…” is the widest label; Copy link is already wider than “Copied”.
    expect(await relabel(head, 'Summarize back', 'Summary requested…')).toBe(true);
    const widest = await layout(head);
    expect(await relabel(head, 'Summary requested…', 'Summarize back')).toBe(true);
    if (JSON.stringify(plain) !== JSON.stringify(widest)) moved.push(w);
  }
  expect(moved, 'head widths where a label change moved a button').toEqual([]);
});
