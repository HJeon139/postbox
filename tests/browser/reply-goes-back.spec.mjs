// #1518: a reply that @-mentions no one, from a turn another agent’s mention started, goes back to that agent, and the
// transcript says so under the reply. A note, not a card: nothing waits on the person.
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
/** What each agent says, turn by turn, by handle. @type {Map<string, string[]>} */
const scripts = new Map();
test.beforeAll(async () => {
  app = await startPostbox('reply-goes-back');
  arrange.withAdapter(app.rt, {
    name: 'claude-code',
    folderFor: async () => app.root,
    async deliver(session, _given, ctx) {
      ctx.text(scripts.get(session.handle)?.shift() ?? 'Nothing more from me.');
    },
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('a reply that names no one goes back to the agent that asked, with a note under it, once', async ({ page }) => {
  const [asker, answerer] = ['asker', 'answerer'].map((name) => app.rt.createPersona({ handle: name, backend: 'claude-code' }));
  const thread = app.rt.createThread({
    projectId: Object.keys(app.store.state.projects)[0],
    title: 'Reply goes back',
    personaIds: [asker.id, answerer.id],
  });
  scripts.set('asker', ['@answerer which file holds the changelog?', 'Thanks, adding the entry to CHANGELOG.md.']);
  scripts.set('answerer', ['It’s CHANGELOG.md, at the root.']);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: '@asker find out where the changelog goes' });

  const reply = (text) => page.locator('.turn').filter({ has: page.getByText(text, { exact: true }) });
  const answer = reply('It’s CHANGELOG.md, at the root.');
  await expect(answer.locator('.went-back')).toHaveText('Sent back to @asker: this reply @-mentions no one.');
  // The asker woke with it, and its thanks, after a bounce, goes to no one: no note, and the answerer stays idle.
  const thanks = reply('Thanks, adding the entry to CHANGELOG.md.');
  await expect(thanks).toBeVisible();
  await expect(thanks.locator('.went-back')).toHaveCount(0);
  await expect.poll(() => arrange.sessionsIn(app.rt, thread.id).some((se) => arrange.running(app.rt, se.id) || arrange.exiting(app.rt, se.id))).toBe(false);
  expect(scripts.get('asker')).toEqual([]);
  await expect(page.getByText('Nothing more from me.')).toHaveCount(0);
  // Nothing asks the person: no card, no “needs you”.
  expect(app.store.items(thread.id).filter((it) => it.kind === 'hop')).toEqual([]);
  expect(arrange.sessionsIn(app.rt, thread.id).map((se) => se.needs ?? null)).toEqual([null, null]);
});
