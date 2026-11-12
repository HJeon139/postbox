// A room’s running replies, as their words grow and as agents crowd it (designs/rooms-at-scale.md, “Live state”): each
// word is drawn once however long the answer after the last step grows, and ten agents’ running replies fit the
// screen. From agents on a scripted backend (tests/browser/live-scripts.mjs).

import { expect, test } from '@playwright/test';
import { scriptedRoom } from './live-scripts.mjs';
import { synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'live-fit');
const { scripts, hold, go, at, room } = scripted;

const PARAGRAPH = 'The answer goes on in one paragraph with many words to fill the lines of the reply here. ';

for (const agents of [1, 3])
  test(`with ${agents} agent${agents > 1 ? 's' : ''} at work, words before the steps are drawn once while a long answer streams after them`, async ({
    page,
  }) => {
    const handles = ['ana', 'ben', 'cal'].slice(0, agents).map((h) => `${h}${agents}`);
    for (const who of handles)
      scripts.set(who, async ({ emit }) => {
        emit({ kind: 'text', text: `Intro from ${who}.\n\n` });
        for (let i = 1; i <= 3; i++) {
          emit({ kind: 'tool_call', id: `${who}-${i}`, name: 'Bash', input: { command: `make s${i}` }, final: true });
          emit({ kind: 'tool_result', id: `${who}-${i}`, text: 'ok' });
        }
        await hold(who, 1);
        // About 4,500 characters in the same part, past what its share of the screen holds.
        for (let i = 0; i < 50; i++) emit({ kind: 'text', text: PARAGRAPH });
        emit({ kind: 'text', text: `The end from ${who}.` });
        await hold(who, 2);
      });
    const t = room(`Long answers ${agents}`, handles);
    await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
    await synced(page, scripted.app);
    for (const who of handles) scripted.app.rt.sendMessage(t.id, { text: `@${who} explain` });
    await expect.poll(() => handles.every((w) => at(w) === 1)).toBe(true);
    await synced(page, scripted.app);
    await expect(page.locator('.live-steps', { hasText: 'make s3' }), 'the steps are drawn first').toHaveCount(agents);
    for (const who of handles) go(who);
    await expect.poll(() => handles.every((w) => at(w) === 2)).toBe(true);
    await synced(page, scripted.app);
    for (const who of handles) {
      await expect(page.locator('.transcript'), 'the long answer is drawn').toContainText(`The end from ${who}.`);
      const intro = page.locator('.transcript').getByText(`Intro from ${who}.`).filter({ visible: true });
      await expect(intro, `“Intro from ${who}.” once, while the turn runs`).toHaveCount(1);
    }
    for (const who of handles) go(who);
    await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
  });

for (const [width, height] of [
  [1440, 900],
  [1280, 800],
])
  test(`ten agents’ running replies fit the screen at ${width} × ${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const ten = ['ca', 'da', 'ea', 'fa', 'ga', 'ha', 'ia', 'ja', 'ka', 'la'].map((h) => `${h}${width}`);
    for (const who of ten)
      scripts.set(who, async ({ emit }) => {
        emit({ kind: 'text', text: 'Looking at the parser and the tests first, then the sums.' });
        emit({ kind: 'thinking', text: 'The parser drops empty fields, so the sums shift by one. '.repeat(10).trim(), block: 'th1' });
        emit({ kind: 'thinking_end', block: 'th1' });
        for (let i = 1; i <= 9; i++) {
          emit({ kind: 'tool_call', id: `${who}-${i}`, name: 'Bash', input: { command: `make step-${i}` }, final: true });
          emit({ kind: 'tool_result', id: `${who}-${i}`, text: `step ${i} ok` });
        }
        emit({ kind: 'text', text: ' Now the sums.' });
        // Held while a step runs, as agents at work are, so each one’s working row would show too.
        emit({ kind: 'tool_call', id: `${who}-10`, name: 'Bash', input: { command: 'make sums' }, final: true });
        await hold(who, 1);
      });
    const t = room(`Ten at ${width}`, ten);
    await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
    await synced(page, scripted.app);
    for (const who of ten) scripted.app.rt.sendMessage(t.id, { text: `@${who} fix the sums` });
    await expect.poll(() => ten.every((w) => at(w) === 1), { timeout: 30_000 }).toBe(true);
    await synced(page, scripted.app);
    await expect(page.locator('.live-steps.crowded'), 'each reply crowded to one line of steps').toHaveCount(10);
    const { used, visible } = await page.evaluate(() => {
      const replies = [...document.querySelectorAll('.transcript > [data-key]')].filter((n) => n.querySelector(':scope > .live-steps'));
      const rows = [...document.querySelectorAll('.working .work-row')];
      const transcript = document.querySelector('.transcript');
      let el = transcript?.parentElement;
      while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
      const bar = el ? 0 : (document.querySelector('header.topbar')?.getBoundingClientRect().bottom ?? 0);
      const composer = /** @type {HTMLElement | null | undefined} */ (transcript?.parentElement?.querySelector(':scope > .composer'))?.offsetHeight ?? 0;
      return {
        // From the first running reply’s top to the last one’s bottom, the space between them included, and the rows.
        used:
          (replies.at(-1)?.getBoundingClientRect().bottom ?? 0) -
          (replies[0]?.getBoundingClientRect().top ?? 0) +
          rows.reduce((s, n) => s + n.getBoundingClientRect().height, 0),
        visible: (el?.clientHeight || innerHeight) - bar - composer,
      };
    });
    await expect(page.locator('.live-steps.crowded li.step-line', { hasText: 'make sums' }), 'each running its step').toHaveCount(10);
    // An agent’s working row hides once its reply is seen in view, which leaves room for the next: they settle to none.
    await expect(page.locator('.working .work-row:visible'), 'no working row repeats a reply in view').toHaveCount(0);
    expect(used, `ten running replies and their working rows, in pixels, against ${Math.round(visible)} px of transcript`).toBeLessThanOrEqual(visible);
    // The rest of a crowded reply is a click away.
    const more = page.getByRole('button', { name: 'Show the whole reply' }).first();
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.transcript'), 'its words, whole').toContainText('Looking at the parser and the tests first, then the sums.');
    await expect(page.getByRole('button', { name: 'Show less of the reply' }), 'and back to a line of them').toHaveCount(1);
    expect(await page.evaluate(() => document.activeElement?.tagName), 'focus stays on the control').toBe('BUTTON');
    for (const w of ten) go(w);
    await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
  });

test('a crowded agent keeps its working row while its running reply is off screen, and loses it while the reply is in view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ten = ['ma', 'na', 'oa', 'pa', 'qa', 'ra', 'sa', 'ta', 'ua', 'va'];
  for (const who of ten)
    scripts.set(who, async ({ emit }) => {
      emit({ kind: 'text', text: `Working on it, from ${who}.` });
      emit({ kind: 'tool_call', id: `${who}-1`, name: 'Bash', input: { command: 'make sums' }, final: true });
      await hold(who, 1);
    });
  const t = room('One off screen', ten);
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  // The first agent’s reply, then forty posts under it, then the other nine agents’ replies below them.
  scripted.app.rt.sendMessage(t.id, { text: '@ma go' });
  await expect.poll(() => at('ma')).toBe(1);
  for (let i = 0; i < 40; i++) scripted.app.rt.addItem(t.id, { kind: 'user', text: `A post in the room, number ${i + 1}.` });
  for (const who of ten.slice(1)) scripted.app.rt.sendMessage(t.id, { text: `@${who} go` });
  await expect.poll(() => ten.every((w) => at(w) === 1)).toBe(true);
  await synced(page, scripted.app);
  await expect(page.locator('.live-steps.crowded'), 'each reply crowded').toHaveCount(10);
  const row = (/** @type {string} */ who) => page.locator('.working .work-row').filter({ has: page.locator('b', { hasText: new RegExp(`^${who}$`) }) });
  await expect(row('ma'), 'the agent whose reply is off screen keeps its row').toBeVisible();
  await expect(row('va'), 'an agent whose reply is in view has none').toBeHidden();
  const reply = page.locator('.transcript > [data-key]', { hasText: 'Working on it, from ma.' });
  await reply.scrollIntoViewIfNeeded();
  await expect(row('ma'), 'its reply scrolled into view: no row').toBeHidden();
  await page.locator('.transcript > [data-key]', { hasText: 'Working on it, from va.' }).scrollIntoViewIfNeeded();
  await expect(row('ma'), 'and out of view again: its row is back').toBeVisible();
  for (const w of ten) go(w);
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
});
