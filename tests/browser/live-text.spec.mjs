// A running reply’s words reach the page a window at a time (designs/architecture/live-progress.md, “Text in
// windows”): stored once a window of LIVE_TEXT.windowMs, they show while the turn runs, and a page that reloads or
// opens the conversation mid-turn shows them from the store, every word once, at the end too.

import { expect, test } from '@playwright/test';
import { scriptedRoom } from './live-scripts.mjs';
import { synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'live-text');
const { scripts, hold, at, room, go } = scripted;

/** How many times `words` show in the reply. @param {import('@playwright/test').Page} page @param {string} id @param {string} words */
const times = (page, id, words) => page.locator(`[data-key="${id}"]`).evaluate((n, w) => (n.textContent ?? '').split(w).length - 1, words);

test('a running reply’s words show while it runs, again after a reload and in a conversation opened mid-turn, and once at the end', async ({ page }) => {
  const t = room('Live text', ['reader']);
  const other = room('Elsewhere, for words', ['bystander']);
  scripts.set('reader', async ({ emit, who }) => {
    emit({ kind: 'text', text: 'Reading the shelf.' });
    emit({ kind: 'tool_call', id: 'r0', name: 'Read', input: { file_path: 'shelf.txt' }, final: true });
    emit({ kind: 'tool_result', id: 'r0', text: 'three books' });
    emit({ kind: 'text', text: ' Found three books.' });
    await hold(who, 1);
    emit({ kind: 'text', text: ' That’s all.' });
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'What’s on the shelf?' });
  await expect.poll(() => at('reader')).toBe(1);
  const reply = /** @type {any} */ (scripted.app.store.items(t.id).find((i) => i.kind === 'agent'));
  const el = page.locator(`[data-key="${reply.id}"]`);
  await expect(el, 'the words while the turn runs').toContainText('Found three books.');

  await page.reload();
  await synced(page, scripted.app);
  await expect(el, 'after a reload, from the store').toContainText('Found three books.');
  expect(await times(page, reply.id, 'Found three books.'), 'once').toBe(1);

  await page.goto(`${scripted.app.origin}/#/t/${other.id}`);
  await synced(page, scripted.app);
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await expect(el, 'opened mid-turn').toContainText('Found three books.');
  expect(await times(page, reply.id, 'Found three books.'), 'once').toBe(1);

  go('reader');
  await expect(el).toContainText('That’s all.');
  // Words after a tool’s call start a paragraph, as they always have.
  await expect
    .poll(() => scripted.app.store.items(t.id).find((i) => i.id === reply.id)?.text, { message: 'stored whole at the end' })
    .toBe('Reading the shelf.\n\n Found three books. That’s all.');
  for (const words of ['Reading the shelf.', 'Found three books.', 'That’s all.']) expect(await times(page, reply.id, words), words).toBe(1);
});

// A page that never had the conversation open opens it partway through a turn: it reads the words stored so far from
// the store, then each window after, and never shows a window twice (the integrator's review of the rework, #1502).
test('a conversation first opened partway through a turn catches up from the stored words, then shows each window once', async ({ page }) => {
  const t = room('Live text, opened late', ['writer']);
  const other = room('Elsewhere, before opening', ['onlooker']);
  scripts.set('writer', async ({ emit, who }) => {
    for (const w of ['One. ', 'Two. ', 'Three. ']) emit({ kind: 'text', text: w });
    await hold(who, 1);
    for (const w of ['Four. ', 'Five. ']) emit({ kind: 'text', text: w });
    await hold(who, 2);
    emit({ kind: 'text', text: 'Six.' });
  });
  await page.goto(`${scripted.app.origin}/#/t/${other.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Count to six.' });
  await expect.poll(() => at('writer')).toBe(1);
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  const reply = /** @type {any} */ (scripted.app.store.items(t.id).find((i) => i.kind === 'agent'));
  const el = page.locator(`[data-key="${reply.id}"]`);
  await expect(el, 'the words stored before it opened').toContainText('One. Two. Three.');
  go('writer');
  await expect.poll(() => at('writer')).toBe(2);
  await expect(el, 'the next window').toContainText('Three. Four. Five.');
  go('writer');
  await expect(el).toContainText('Five. Six.');
  for (const w of ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']) expect(await times(page, reply.id, w), w).toBe(1);
});
