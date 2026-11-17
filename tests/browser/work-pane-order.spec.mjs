// The Work pane in the order people open it for (#1446): In this chat first, with what the latest messages name and
// the latest turns touched, newest first, updating as a reply lands; then Files and the room’s assets; Commands,
// Outside Postbox, Spend and Turns under More, closed, unless a command in the latest turn failed.

import { expect, test } from '@playwright/test';
import { writeAsset } from '../../server/assets.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
let conv;
let se;
/** @type {Record<string, string>} */
const ids = {};

test.beforeAll(async () => {
  app = await startPostbox('work-pane-order');
  const { rt, store } = app;
  conv = Object.values(store.state.threads).find((t) => t.title === 'Asset explorer');
  for (const [key, name] of [
    ['plan', 'notes/plan.md'],
    ['todo', 'notes/todo.md'],
  ]) {
    const r = await writeAsset(store, rt.assets.roomBlobs(), {
      kind: 'write',
      room: conv.id,
      name,
      bytes: Buffer.from(`# ${key}\n`),
      type: 'text/markdown',
      author: 'librarian',
    });
    if (!r.ok) throw new Error(r.message);
    ids[key] = r.id;
  }
  // A turn that ran one command, which worked, begun after every asset was written, so it touched none.
  arrange.addWork(rt, conv.id, { id: 'wt_one', kind: 'turn', handle: 'librarian', startedAt: Date.now(), status: 'done' });
  arrange.addWork(rt, conv.id, { id: 'wx_ok', kind: 'command', turnId: 'wt_one', command: 'ls notes', state: 'done', exit: 0, handle: 'librarian' });
  se = arrange.sessionsIn(rt, conv.id)[0];
  say('Start with `notes/plan.md`.');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A finished reply from the room’s agent. @param {string} text */
function say(text) {
  arrange.post(app.rt, conv.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, status: 'done', text });
}

const open = async (page) => {
  await page.goto(`${app.origin}/#/t/${conv.id}?work`);
  await synced(page, app);
};
const sections = (page) => page.locator('.wp-body > *').evaluateAll((els) => els.map((el) => el.querySelector('h2, summary')?.id ?? ''));

test('In this chat leads, and a new reply that names an asset by its id puts it first', async ({ page }) => {
  await open(page);
  await expect.poll(() => sections(page)).toEqual(['wc-now-h', 'wc-files-h', 'wc-assets-h', 'wc-more-s']);
  const now = page.locator('#wc-now-h').locator('..').locator('.wc-row');
  await expect(now).toHaveText([/plan\.md/]);
  say(`Then ${ids.todo}.`);
  await synced(page, app);
  await expect(now, 'both, the newest named first').toHaveText([/todo\.md/, /plan\.md/]);
  await now.first().click();
  await expect(page.locator('#work-pane .wv').getByRole('heading', { name: 'notes/todo.md' })).toBeVisible();
});

test('More is closed and builds its sections only when opened; it stays open as the pane updates', async ({ page }) => {
  await open(page);
  const more = page.locator('#wc-more-s');
  await expect(more).toHaveText(/More\s*Commands, Spend, Turns/);
  await expect(page.locator('#wc-commands-h'), 'commands, none failed: under More').toHaveCount(0);
  await more.press('Enter');
  await expect(page.locator('#wc-more #wc-commands-h')).toBeVisible();
  say('Nothing new.');
  await synced(page, app);
  await expect(page.locator('#wc-more')).toHaveAttribute('open', '');
  await expect(more).toBeFocused();
});

test('a command that failed in the latest turn keeps Commands in view', async ({ page }) => {
  arrange.addWork(app.rt, conv.id, { id: 'wt_two', kind: 'turn', handle: 'librarian', startedAt: Date.now(), status: 'done' });
  arrange.addWork(app.rt, conv.id, { id: 'wx_bad', kind: 'command', turnId: 'wt_two', command: 'cat nope', state: 'failed', exit: 1, handle: 'librarian' });
  await open(page);
  await expect(page.locator('.wp-body > section #wc-commands-h')).toBeVisible();
  await expect(page.locator('#wc-more-s')).not.toContainText('Commands');
});
