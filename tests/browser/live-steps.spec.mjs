// A running turn’s steps as they happen, and a finished turn’s one-line record (designs/rooms-at-scale.md, “Live
// state”), from agents on a scripted backend (tests/browser/live-scripts.mjs).

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { scriptedRoom } from './live-scripts.mjs';
import { synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'live-steps');
const { scripts, hold, go, at, room, edit } = scripted;

test('the newest step shows in full, an edit as its diff; an older one is a line with its counts', async ({ page }) => {
  await writeFile(join(scripted.app.root, 'calc.py'), 'def add(a, b):\n    return a - b\n');
  const t = room('Newest in full', ['fixer']);
  scripts.set('fixer', async ({ emit, who }) => {
    emit({ kind: 'tool_call', id: 'r1', name: 'Read', input: { file_path: join(scripted.app.root, 'calc.py') }, final: true });
    emit({ kind: 'tool_result', id: 'r1', text: 'def add(a, b):\n    return a - b' });
    await edit(emit, 'e1', 'calc.py', '    return a - b', '    return a + b');
    await hold(who, 1);
    emit({ kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'python -m pytest -q' }, final: true });
    emit({ kind: 'tool_result', id: 'b1', text: '....\n4 passed in 0.02s' });
    await hold(who, 2);
    emit({ kind: 'text', text: 'Fixed `add`.' });
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Fix add.' });
  await expect.poll(() => at('fixer')).toBe(1);
  const live = page.locator('.live-steps');
  await test.step('the edit, newest, shows in full with its diff', async () => {
    const full = live.locator('li.step-full');
    await expect(full).toHaveCount(1);
    await expect(full).toContainText('Edited calc.py');
    await expect(full.locator('.step-diff .del')).toHaveText('-    return a - b');
    await expect(full.locator('.step-diff .add')).toHaveText('+    return a + b');
    await expect(full.locator('.step-input, .step-output'), 'the diff says it, not its input again').toHaveCount(0);
    await expect(live.locator('li.step-line', { hasText: 'Read calc.py' }), 'the read before it is one line').toHaveCount(1);
  });
  go('fixer');
  await expect.poll(() => at('fixer')).toBe(2);
  await test.step('the command, newest, shows its output; the edit is one line, its counts green and red', async () => {
    await expect(live.locator('li.step-full')).toContainText('4 passed in 0.02s');
    const line = live.locator('li.step-line', { hasText: 'Edited calc.py' });
    await expect(line.locator('.work-n .add')).toHaveText('+1');
    await expect(line.locator('.work-n .del')).toHaveText('−1');
  });
  go('fixer');
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
});

test('a turn’s own words sit between its steps, in the order it wrote and ran them', async ({ page }) => {
  await writeFile(join(scripted.app.root, 'notes.txt'), 'alpha\n');
  const t = room('Words between steps', ['writer']);
  scripts.set('writer', async ({ emit, who }) => {
    emit({ kind: 'text', text: 'Reading the notes first.' });
    emit({ kind: 'tool_call', id: 'r1', name: 'Read', input: { file_path: join(scripted.app.root, 'notes.txt') }, final: true });
    emit({ kind: 'tool_result', id: 'r1', text: 'alpha' });
    emit({ kind: 'text', text: 'One line; adding a second.' });
    await edit(emit, 'e1', 'notes.txt', 'alpha', 'alpha\nbeta');
    await hold(who, 1);
    emit({ kind: 'text', text: 'Done.' });
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Add beta.' });
  await expect.poll(() => at('writer')).toBe(1);
  const reply = page.locator('.turn', { has: page.locator('.live-steps') });
  await expect(reply).toContainText('Edited notes.txt');
  const text = (await reply.textContent()) ?? '';
  const order = ['Reading the notes first.', 'Read notes.txt', 'One line; adding a second.', 'Edited notes.txt'].map((s) => text.indexOf(s));
  expect(
    order.every((i) => i >= 0),
    text,
  ).toBe(true);
  expect(order, 'each in the order it happened').toEqual([...order].sort((a, b) => a - b));
  for (const words of ['Reading the notes first.', 'One line; adding a second.'])
    expect(text.split(words).length - 1, `“${words}” drawn once, between the steps or in the reply, not both`).toBe(1);
  go('writer');
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
});

test('a finished turn’s steps fold into its work record at the top of the post, which opens to them and to Work', async ({ page }) => {
  await writeFile(join(scripted.app.root, 'calc2.py'), 'x = 1\n');
  const t = room('Work record', ['recorder']);
  scripts.set('recorder', async ({ emit }) => {
    await edit(emit, 'e1', 'calc2.py', 'x = 1', 'x = 2');
    emit({ kind: 'text', text: 'Set x to 2.' });
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Set x.' });
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
  await synced(page, scripted.app);
  const post = page.locator('.turn', { hasText: 'Set x to 2.' });
  const record = post.locator('details.activity');
  await expect(record).not.toHaveAttribute('open', '');
  await expect(record.locator('> summary'), 'the turn’s record').toContainText('1 file +1 −1');
  expect(await post.evaluate((el) => el.querySelector('details.activity')?.compareDocumentPosition(/** @type {Node} */ (el.querySelector('.md'))) ?? 0)).toBe(
    4,
  );
  await record.locator('> summary').click();
  await expect(record.locator('.steps'), 'it opens to the steps').toContainText('Edited calc2.py');
  await expect(record.getByRole('link', { name: /Work/ }), 'and to Work').toBeVisible();
  const said = ((await post.textContent()) ?? '').split('1 file +1 −1').length - 1;
  expect(said, 'the turn’s line shows once, in its record, not again over the work list under it').toBe(1);
  await expect(post.locator('.work-list-turn .wl-row'), 'nor its edit again under it: the record lists its calls').toHaveCount(0);
});

test('detail fades within each agent’s share of the screen: four agents show a few lines each, eight a line each', async ({ page }) => {
  const four = ['ana', 'ben', 'cal', 'dee'];
  const eight = ['eve', 'fay', 'gus', 'hal', 'ivy', 'jon', 'kim', 'lou'];
  for (const who of [...four, ...eight])
    scripts.set(who, async ({ emit }) => {
      for (let i = 1; i <= 9; i++) {
        emit({ kind: 'tool_call', id: `${who}-${i}`, name: 'Bash', input: { command: `make step-${i}` }, final: true });
        emit({ kind: 'tool_result', id: `${who}-${i}`, text: `step ${i} ok` });
      }
      await hold(who, 1);
    });
  const show = async (/** @type {string[]} */ handles) => {
    const t = room(`${handles.length} agents`, handles);
    // A room the page hasn’t heard of yet isn’t one it can open: with the stream late, it waits for it first.
    if (page.url().startsWith(scripted.app.origin)) await synced(page, scripted.app);
    await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
    await expect(page.locator('.transcript'), 'the new room is open').toHaveAttribute('data-thread', t.id);
    await synced(page, scripted.app);
    scripted.app.rt.sendMessage(t.id, { text: `${handles.map((w) => `@${w}`).join(' ')} build` });
    await expect.poll(() => handles.map((w) => `${w}:${at(w)}`).join(' ')).toBe(handles.map((w) => `${w}:1`).join(' '));
    await synced(page, scripted.app);
    return t;
  };
  await test.step('four agents: the newest step in full, a few lines, the rest as earlier steps', async () => {
    await show(four);
    const blocks = page.locator('.live-steps');
    await expect(blocks).toHaveCount(4);
    for (const b of await blocks.all()) {
      await expect(b.locator('li.step-full')).toHaveCount(1);
      await expect(b.locator('details.earlier > summary')).toHaveText(/\d+ earlier steps/);
      expect((await b.boundingBox())?.height ?? 0, 'within its share of 760 px').toBeLessThanOrEqual(200);
    }
    for (const w of four) go(w);
    await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
  });
  await test.step('eight agents: one line each, what it’s doing and its step count', async () => {
    await show(eight);
    const blocks = page.locator('.live-steps');
    await expect(blocks).toHaveCount(8);
    for (const b of await blocks.all()) {
      await expect(b).toHaveClass(/crowded/);
      await expect(b).toContainText('9 steps');
      await expect(b.locator('li.step-full')).toHaveCount(0);
    }
    for (const w of eight) go(w);
    await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
  });
});

test('a running turn’s thoughts show whole, paragraphs and all, between its steps', async ({ page }) => {
  const thought = `${'The sum is wrong because the operator is a minus. '.repeat(30)}\n\nI’ll fix the operator, then run the tests to be sure nothing else depends on the bug.`;
  const t = room('Whole thoughts', ['thinker']);
  scripts.set('thinker', async ({ emit, who }) => {
    emit({ kind: 'thinking', text: thought, block: 'th1' });
    emit({ kind: 'thinking_end', block: 'th1' });
    emit({ kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'python -m pytest -q' }, final: true });
    await hold(who, 1);
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Why is add wrong?' });
  await expect.poll(() => at('thinker')).toBe(1);
  const shown = page.locator('.live-steps .live-thought');
  await expect(shown).toHaveCount(1);
  expect(await shown.textContent(), 'the whole thought, its paragraph break kept').toBe(thought);
  expect(await shown.evaluate((e) => getComputedStyle(e).fontStyle), 'set apart from the reply’s words').toBe('italic');
  await expect(page.locator('.work-row', { hasText: 'thinker' }), 'its working row').toHaveCount(1);
  await expect(page.locator('.work-row .glimpse'), 'which doesn’t say the thought again').toHaveCount(0);
  go('thinker');
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
});

test('a thought shows while the agent writes it, its text so far, and then whole', async ({ page }) => {
  const t = room('A thought as it’s written', ['ponderer']);
  scripts.set('ponderer', async ({ emit, who }) => {
    emit({ kind: 'thinking', text: 'The sum is wrong because', block: 'th1' });
    scripted.ahead += 1100; // a thought first shows a second after it began
    emit({ kind: 'thinking', text: ' the operator is a minus.', block: 'th1' });
    await hold(who, 1);
    emit({ kind: 'thinking', text: ' I’ll fix it.', block: 'th1' });
    emit({ kind: 'thinking_end', block: 'th1' });
    await hold(who, 2);
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Why is add wrong?' });
  await expect.poll(() => at('ponderer')).toBe(1);
  const shown = page.locator('.live-steps .live-thought');
  await expect(shown, 'before it ends, its text so far').toHaveText('The sum is wrong because the operator is a minus.');
  go('ponderer');
  await expect.poll(() => at('ponderer')).toBe(2);
  await expect(shown, 'once it ends, whole, in the same place').toHaveText('The sum is wrong because the operator is a minus. I’ll fix it.');
  await expect(shown).toHaveCount(1);
  go('ponderer');
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
});

test('a step landing keeps “N earlier steps” open, and its summary focused, as you left them', async ({ page }) => {
  const t = room('Earlier steps kept', ['busy']);
  scripts.set('busy', async ({ emit, who }) => {
    for (let i = 1; i <= 40; i++) {
      emit({ kind: 'tool_call', id: `s${i}`, name: 'Bash', input: { command: `make part-${i}` }, final: true });
      emit({ kind: 'tool_result', id: `s${i}`, text: `part ${i} ok` });
    }
    await hold(who, 1);
    emit({ kind: 'tool_call', id: 's41', name: 'Bash', input: { command: 'make part-41' }, final: true });
    await hold(who, 2);
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Build it.' });
  await expect.poll(() => at('busy')).toBe(1);
  const earlier = page.locator('.live-steps details.earlier');
  await earlier.locator('> summary').focus();
  await page.keyboard.press('Enter');
  await expect(earlier).toHaveAttribute('open', '');
  go('busy');
  await expect.poll(() => at('busy')).toBe(2);
  await expect(page.locator('li.step-full'), 'the step landed').toContainText('make part-41');
  await expect(earlier, 'still open').toHaveAttribute('open', '');
  await expect(earlier.locator('> summary'), 'still focused').toBeFocused();
  go('busy');
  await expect.poll(() => scripted.app.rt.turns.size).toBe(0);
});
