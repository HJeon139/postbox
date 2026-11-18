// A running reply’s words reach the page live, and are stored only at a commit point (designs/architecture/live-progress.md,
// step 4): a step of the agent’s own, the part settling, 10 s with no commit, 64 KB of words, or the turn’s end. A page
// that reloads or opens the conversation mid-turn draws the words since the last commit point from the running turn’s
// snapshot, and every word shows once, at the end too.

import { expect, test } from '@playwright/test';
import { scriptedRoom } from './live-scripts.mjs';
import { synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'live-text');
const { scripts, hold, at, room, go } = scripted;

/** How many times `words` show in the reply. @param {import('@playwright/test').Page} page @param {string} id @param {string} words */
const times = (page, id, words) =>
  page.locator(`[data-key="${id}"]`).evaluate((n, w) => /** @type {HTMLElement} */ (n).textContent?.split(w).length - 1 ?? 0, words);

test('words since the last commit point show live, again after a reload and in a conversation opened mid-turn, and once at the end', async ({ page }) => {
  const t = room('Live text', ['reader']);
  const other = room('Elsewhere, for words', ['bystander']);
  scripts.set('reader', async ({ emit, who }) => {
    emit({ kind: 'text', text: 'Reading the shelf.' });
    emit({ kind: 'tool_call', id: 'r0', name: 'Read', input: { file_path: 'shelf.txt' }, final: true }); // a commit point
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
  await expect(el, 'the words after the commit point, live').toContainText('Found three books.');
  expect(reply.text, 'stored to the commit point only').toBe('Reading the shelf.');

  await page.reload();
  await synced(page, scripted.app);
  await expect(el, 'after a reload, from the snapshot').toContainText('Found three books.');
  expect(await times(page, reply.id, 'Found three books.'), 'once').toBe(1);

  await page.goto(`${scripted.app.origin}/#/t/${other.id}`);
  await synced(page, scripted.app);
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await expect(el, 'opened mid-turn, from the snapshot').toContainText('Found three books.');
  expect(await times(page, reply.id, 'Found three books.'), 'once').toBe(1);

  go('reader');
  await expect(el).toContainText('That’s all.');
  // Words after a tool’s call start a paragraph, as they always have.
  await expect
    .poll(() => scripted.app.store.items(t.id).find((i) => i.id === reply.id)?.text, { message: 'stored whole at the end' })
    .toBe('Reading the shelf.\n\n Found three books. That’s all.');
  for (const words of ['Reading the shelf.', 'Found three books.', 'That’s all.']) expect(await times(page, reply.id, words), words).toBe(1);
});
