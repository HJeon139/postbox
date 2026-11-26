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

test('an agent’s second reply in a row that only writes posts with no note, and wakes no one (#1591)', async ({ page }) => {
  const [first, second] = ['closer', 'acker'].map((name) => app.rt.createPersona({ handle: name, backend: 'claude-code' }));
  const thread = app.rt.createThread({
    projectId: Object.keys(app.store.state.projects)[0],
    title: 'Nothing to add',
    personaIds: [first.id, second.id],
  });
  // The lines two agents sent each other about 50 times each in a UAT run of 23 November 2026.
  scripts.set('closer', ['@acker the plan is at v2.', 'Nothing here is for me to act on.', 'So I’m ending without a reply.']);
  scripts.set('acker', ['Acknowledged. The plan stays at v2.', 'Acknowledged again.']);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: '@closer tell acker where the plan is' });

  const reply = (text) => page.locator('.turn').filter({ has: page.getByText(text, { exact: true }) });
  await expect(reply('Acknowledged. The plan stays at v2.').locator('.went-back')).toHaveText('Sent back to @closer: this reply @-mentions no one.');
  // One reply that only writes is delivered from each: it may be a question, or an answer the other waits for.
  await expect(reply('Nothing here is for me to act on.').locator('.went-back')).toHaveText('Sent back to @acker: this reply @-mentions no one.');
  await expect(reply('Acknowledged again.').locator('.went-back')).toHaveText('Sent back to @closer: this reply @-mentions no one.');
  const closing = reply('So I’m ending without a reply.');
  await expect(closing).toBeVisible();
  await expect.poll(() => arrange.sessionsIn(app.rt, thread.id).some((se) => arrange.running(app.rt, se.id) || arrange.exiting(app.rt, se.id))).toBe(false);
  await expect(closing.locator('.went-back')).toHaveCount(0);
  // acker wasn’t woken again: its script’s fallback line never posts, and no card asks the person.
  await expect(page.getByText('Nothing more from me.')).toHaveCount(0);
  expect(app.store.items(thread.id).filter((it) => it.kind === 'hop')).toEqual([]);
});

test('an ask whose answer went to another agent reads “No reply from …” under it, until the answer reaches its asker (#634)', async ({ page }) => {
  const [asker, answerer, third] = ['pinger', 'ponger', 'thirdy'].map((name) => app.rt.createPersona({ handle: name, backend: 'claude-code' }));
  const thread = app.rt.createThread({
    projectId: Object.keys(app.store.state.projects)[0],
    title: 'No reply',
    personaIds: [asker.id, answerer.id, third.id],
  });
  scripts.set('pinger', ['@ponger is the relay green?', REACT]);
  scripts.set('ponger', ['@thirdy can you check the relay for me?', '@pinger yes, it’s green.']);
  // thirdy ends it with a reaction, so nothing comes back to ponger before the person asks it.
  scripts.set('thirdy', [REACT]);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: '@pinger find out if the relay is green' });

  const reply = (text) => page.locator('.turn').filter({ has: page.getByText(text, { exact: true }) });
  const ask = reply('@ponger is the relay green?');
  await expect(ask.locator('.no-reply')).toHaveText('No reply from @ponger.');
  // A quiet line: nothing asks the person.
  expect(arrange.sessionsIn(app.rt, thread.id).map((se) => se.needs ?? null)).toEqual([null, null, null]);
  // ponger answers pinger later, and the line goes.
  app.rt.sendMessage(thread.id, { text: '@ponger tell pinger' });
  await expect(reply('@pinger yes, it’s green.')).toBeVisible();
  await expect(ask.locator('.no-reply')).toHaveCount(0);
});
