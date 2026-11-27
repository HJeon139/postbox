// The wake chain’s loop guard on a live page (#1623; designs/intent.md, principle 6): two agents that keep
// @-mentioning each other run until the cap of agent wakes in a row, then stop. The room shows one line, with no card,
// no button and nothing that needs the person, and the person’s next message lets them wake each other again.
// tests/browser/chain-stop.spec.mjs checks the line on a room arranged at the cap; this one runs the loop itself.
import { expect, test } from '@playwright/test';
import { HOP_LIMIT } from '../../shared/limits.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
const REACT = Symbol('react');
/** What each agent says, turn by turn, by handle, once the loop is over; REACT reacts 👍 instead. @type {Map<string, any[]>} */
const scripts = new Map();
/** While true, each agent answers by @-mentioning the other, for ever. */
let looping = true;
const other = { ping: 'pong', pong: 'ping' };
/** How many turns each agent took. @type {Map<string, number>} */
const turns = new Map();

test.beforeAll(async () => {
  app = await startPostbox('chain-stop-loop');
  arrange.withAdapter(app.rt, {
    name: 'claude-code',
    folderFor: async () => app.root,
    async deliver(session, given, ctx) {
      turns.set(session.handle, (turns.get(session.handle) ?? 0) + 1);
      if (looping) return ctx.text(`@${other[session.handle]} check it once more`);
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

const LINE = `Agents stopped waking each other after ${HOP_LIMIT.toLocaleString('en-US')} wakes in a row. Your next message lets them start again.`;
const idle = (threadId) => !arrange.sessionsIn(app.rt, threadId).some((se) => arrange.running(app.rt, se.id) || arrange.exiting(app.rt, se.id));

test('two agents that loop stop at the cap with one line, no card and nothing that needs you, and your next message starts them again', async ({ page }) => {
  const [ping, pong] = ['ping', 'pong'].map((handle) => app.rt.createPersona({ handle, backend: 'claude-code' }));
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: 'Loop', personaIds: [ping.id, pong.id] });
  // Three wakes short of the cap, rather than a thousand turns: the loop runs live from here.
  arrange.setThread(app.rt, thread.id, { hops: HOP_LIMIT - 3 });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  arrange.wake(app.rt, arrange.agentIn(app.rt, thread.id, 'ping').id, 'pong', 'check it');

  const transcript = page.locator('.transcript');
  await expect(transcript.locator('.sys-line').filter({ hasText: LINE })).toHaveCount(1);
  await expect.poll(() => idle(thread.id)).toBe(true);
  // The wake that would have been past the cap didn’t go: three wakes, each a turn, and the turn whose mention stopped.
  expect((turns.get('ping') ?? 0) + (turns.get('pong') ?? 0)).toBe(3);
  await expect(transcript.locator('.sys-line').filter({ hasText: LINE })).toHaveCount(1);
  await expect(transcript.locator('.block')).toHaveCount(0);
  await expect(transcript.getByRole('button', { name: /wake|allow/i })).toHaveCount(0);
  await expect(page.locator(`.rail a.row[data-thread="${thread.id}"] .g-needs`)).toHaveCount(0);
  expect(app.store.items(thread.id).filter((it) => it.kind === 'hop')).toEqual([]);
  expect(arrange.sessionsIn(app.rt, thread.id).map((se) => se.needs ?? null)).toEqual([null, null]);

  // Your message starts a new chain: ping’s mention wakes pong again, and pong ends the exchange with a reaction.
  looping = false;
  scripts.set('ping', ['@pong one last check']);
  scripts.set('pong', [REACT]);
  await page.locator('#composer-input').fill('@ping finish up');
  await page.locator('#composer-input').press('Enter');
  await expect.poll(() => app.store.items(thread.id).find((it) => it.text === '@pong one last check')?.reactions?.length ?? 0).toBe(1);
  expect(scripts.get('pong')).toEqual([]);
  await expect(transcript.locator('.sys-line').filter({ hasText: LINE })).toHaveCount(1);
});
