// #1518: a reply that @-mentions no one, from a turn another agent’s mention started, goes back to that agent, and the
// transcript says so under the reply. A note, not a card: nothing waits on the person. #1523: every time, until an
// agent ends the exchange with a reaction.
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
const REACT = Symbol('react');
/** What each agent says, turn by turn, by handle; REACT reacts 👍 to the message instead. @type {Map<string, string[]>} */
const scripts = new Map();
test.beforeAll(async () => {
  app = await startPostbox('reply-goes-back');
  arrange.withAdapter(app.rt, {
    name: 'claude-code',
    folderFor: async () => app.root,
    async deliver(session, given, ctx) {
      const said = scripts.get(session.handle)?.shift() ?? 'Nothing more from me.';
      if (said === REACT) ctx.tools.react({ id: given.itemId, emoji: '👍' });
      else ctx.text(said);
    },
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('replies that name no one go back and forth, each with a note under it, until one agent reacts', async ({ page }) => {
  const [asker, answerer] = ['asker', 'answerer'].map((name) => app.rt.createPersona({ handle: name, backend: 'claude-code' }));
  const thread = app.rt.createThread({
    projectId: Object.keys(app.store.state.projects)[0],
    title: 'Reply goes back',
    personaIds: [asker.id, answerer.id],
  });
  scripts.set('asker', ['@answerer which file holds the changelog?', 'Which section?', REACT]);
  scripts.set('answerer', ['It’s CHANGELOG.md, at the root.', 'Under Unreleased.']);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: '@asker find out where the changelog goes' });

  const reply = (text) => page.locator('.turn').filter({ has: page.getByText(text, { exact: true }) });
  const answer = reply('It’s CHANGELOG.md, at the root.');
  await expect(answer.locator('.went-back')).toHaveText('Sent back to @asker: this reply @-mentions no one.');
  // The asker woke with it, and its question back, after a bounce, goes back too, and so does the answer to that.
  await expect(reply('Which section?').locator('.went-back')).toHaveText('Sent back to @answerer: this reply @-mentions no one.');
  const last = reply('Under Unreleased.');
  await expect(last.locator('.went-back')).toHaveText('Sent back to @asker: this reply @-mentions no one.');
  // The asker ends it with a reaction: no reply, so no one wakes.
  await expect.poll(() => app.store.items(thread.id).find((it) => it.text === 'Under Unreleased.')?.reactions?.length ?? 0).toBe(1);
  await expect.poll(() => arrange.sessionsIn(app.rt, thread.id).some((se) => arrange.running(app.rt, se.id) || arrange.exiting(app.rt, se.id))).toBe(false);
  expect(scripts.get('asker')).toEqual([]);
  expect(scripts.get('answerer')).toEqual([]);
  await expect(page.getByText('Nothing more from me.')).toHaveCount(0);
  // Nothing asks the person: no card, no “needs you”.
  expect(app.store.items(thread.id).filter((it) => it.kind === 'hop')).toEqual([]);
  expect(arrange.sessionsIn(app.rt, thread.id).map((se) => se.needs ?? null)).toEqual([null, null]);
});
