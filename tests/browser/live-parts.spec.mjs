// A running reply in parts, and a finished one (designs/rooms-at-scale.md, “Live state”): a post landing below a
// running reply doesn’t break it, and a finished turn’s record sits with its words. From agents on a scripted backend
// (tests/browser/live-scripts.mjs). Moved from live-steps.spec.mjs.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { scriptedRoom } from './live-scripts.mjs';
import { synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'live-parts');
const { scripts, hold, go, at, room, edit } = scripted;

test('a post landing below a running reply doesn’t break it: the steps after the post go with the words after it', async ({ page }) => {
  await writeFile(join(scripted.app.root, 'notes2.txt'), 'alpha\n');
  const t = room('A post below', ['noter']);
  scripts.set('noter', async ({ emit, who }) => {
    emit({ kind: 'text', text: 'Reading the notes.' });
    emit({ kind: 'tool_call', id: 'r1', name: 'Read', input: { file_path: join(scripted.app.root, 'notes2.txt') }, final: true });
    emit({ kind: 'tool_result', id: 'r1', text: 'alpha' });
    await hold(who, 1);
    emit({ kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'wc -l notes2.txt' }, final: true });
    emit({ kind: 'tool_result', id: 'b1', text: '1 notes2.txt' });
    emit({ kind: 'text', text: 'One line, as you said.' });
    await hold(who, 2);
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Count the notes.' });
  await expect.poll(() => at('noter')).toBe(1);
  scripted.app.rt.addItem(t.id, { kind: 'user', text: 'It should be one line.' });
  go('noter');
  await expect.poll(() => at('noter')).toBe(2);
  await synced(page, scripted.app);
  const order = await page.locator('.transcript > [data-key]').evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ''));
  const where = (/** @type {string} */ s) => order.findIndex((x) => x.includes(s));
  await test.step('while it runs, each part shows its own steps, in the order they happened', async () => {
    expect(where('Read notes2.txt'), order.join('\n---\n')).toBeLessThan(where('It should be one line.'));
    expect(where('wc -l notes2.txt'), 'the step after the post shows below it').toBeGreaterThan(where('It should be one line.'));
    expect(where('wc -l notes2.txt'), 'with the words it led to').toBe(where('One line, as you said.'));
    await expect(page.locator('.live-steps', { hasText: 'Read notes2.txt' }), 'the first part shows its step once').toHaveCount(1);
    await expect(page.locator('.live-steps', { hasText: 'wc -l' }), 'and the later step only below').toHaveCount(1);
    await expect(page.locator('li.step-full'), 'only the turn’s newest step shows in full, not each part’s').toHaveCount(1);
    await expect(page.locator('li.step-full')).toContainText('wc -l');
  });
  go('noter');
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
  await synced(page, scripted.app);
  await test.step('once it ends, the turn’s record at its top holds every step', async () => {
    await expect(page.locator('details.activity')).toHaveCount(1);
    const record = page.locator('details.activity');
    await record.locator('> summary').click();
    await expect(record.locator('.steps')).toContainText('Read notes2.txt');
    await expect(record.locator('.steps')).toContainText('wc -l notes2.txt');
  });
});

test('a finished turn whose words came after another agent’s post keeps its record with its words, not above that post', async ({ page }) => {
  await writeFile(join(scripted.app.root, 'calc3.py'), 'x = 1\n');
  const t = room('Record with its words', ['first', 'second']);
  scripts.set('first', async ({ emit, who }) => {
    await edit(emit, 'e1', 'calc3.py', 'x = 1', 'x = 2');
    await hold(who, 1);
    emit({ kind: 'text', text: 'Set x to 2.' });
  });
  scripts.set('second', async ({ emit }) => emit({ kind: 'text', text: 'Second is here.' }));
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: '@first set x' });
  await expect.poll(() => at('first')).toBe(1);
  scripted.app.rt.sendMessage(t.id, { text: '@second say hi' });
  await expect.poll(() => scripted.app.store.items(t.id).some((it) => it.text === 'Second is here.' && it.status === 'done')).toBe(true);
  go('first');
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
  await synced(page, scripted.app);
  const posts = page.locator('.transcript > [data-key]:visible');
  const order = await posts.evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ''));
  const where = (/** @type {string} */ s) => order.findIndex((x) => x.includes(s));
  expect(where('Second is here.'), order.join('\n---\n')).toBeGreaterThanOrEqual(0);
  expect(where('1 file +1 −1'), 'the record is in the post with the words').toBe(where('Set x to 2.'));
  expect(where('Set x to 2.'), 'below the other agent’s post').toBeGreaterThan(where('Second is here.'));
  await expect(page.locator('details.activity:visible'), 'one record for the turn').toHaveCount(1);
});

test('four agents’ running replies fit the screen together: their words, a capped thought, steps and working rows', async ({ page }) => {
  const four = ['amy', 'bob', 'cat', 'dan'];
  const thought = 'The parser drops empty fields, so a trailing comma loses a column, and the sums shift by one. '.repeat(16).trim();
  for (const who of four)
    scripts.set(who, async ({ emit }) => {
      emit({ kind: 'text', text: 'Looking at the parser and the tests first, then the sums.' });
      emit({ kind: 'thinking', text: thought, block: 'th1' });
      emit({ kind: 'thinking_end', block: 'th1' });
      for (let i = 1; i <= 9; i++) {
        emit({ kind: 'tool_call', id: `${who}-${i}`, name: 'Bash', input: { command: `make step-${i}` }, final: true });
        emit({ kind: 'tool_result', id: `${who}-${i}`, text: `step ${i} ok` });
      }
      await hold(who, 1);
    });
  const t = room('Four fit', four);
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  for (const who of four) scripted.app.rt.sendMessage(t.id, { text: `@${who} fix the sums` });
  await expect.poll(() => four.every((w) => at(w) === 1)).toBe(true);
  await synced(page, scripted.app);
  await expect(page.locator('.live-steps .live-thought')).toHaveCount(4);
  const used = await page.evaluate(() => {
    const replies = [...document.querySelectorAll('.transcript > [data-key]')].filter((n) => n.querySelector(':scope > .live-steps:not([hidden])'));
    const rows = [...document.querySelectorAll('.working .work-row')];
    return [...replies, ...rows].reduce((sum, n) => sum + n.getBoundingClientRect().height, 0);
  });
  // 900 px less the top bar and the composer: about 760 px of transcript.
  expect(used, 'the four replies and their working rows, in pixels').toBeLessThanOrEqual(820);
  const first = page.locator('.live-steps .live-thought').first();
  expect(await first.textContent(), 'the whole thought is there, shown in part').toBe(thought);
  await page.getByRole('button', { name: 'Show the whole thought' }).first().focus();
  await page.keyboard.press('Enter');
  await expect(first).not.toHaveClass(/clamped/);
  for (const w of four) go(w);
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
});

test('a resized window paints the running replies to their new share, with no step needed', async ({ page }) => {
  const t = room('Resized', ['tall']);
  scripts.set('tall', async ({ emit, who }) => {
    for (let i = 1; i <= 30; i++) {
      emit({ kind: 'tool_call', id: `r${i}`, name: 'Bash', input: { command: `make part-${i}` }, final: true });
      emit({ kind: 'tool_result', id: `r${i}`, text: `part ${i} ok` });
    }
    await hold(who, 1);
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Build it.' });
  await expect.poll(() => at('tall')).toBe(1);
  await synced(page, scripted.app);
  await expect(page.locator('.live-steps li.step-full'), 'the page has drawn the steps').toContainText('make part-30');
  const lines = page.locator('.live-steps ul.steps.live > li.step-line');
  const before = await lines.count();
  await page.setViewportSize({ width: 1440, height: 500 });
  await expect.poll(() => lines.count(), { message: 'fewer lines fit the shorter window' }).toBeLessThan(before);
  go('tall');
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
});
