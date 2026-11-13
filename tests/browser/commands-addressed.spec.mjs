// Commands aimed at one agent with `@handle /name` (#405), typed as a person types them, in a room with two agents
// where the other one spoke last:
// - `@alpha /compact` runs /compact as @alpha’s turn, and nothing goes out as a message;
// - `@beta /release-notes 2.1` runs @beta’s own command as its turn, with `/release-notes 2.1` as the whole prompt;
// - `@alpha /mode` opens @alpha’s persona sheet, not the last speaker’s;
// - `@alpha /release-notes`, which @alpha doesn’t offer, says so before it’s sent, and goes to @alpha as a message;
// - `@ghost /compact`, a handle no agent here has, says so too, and goes to the last speaker as a message;
// - `@alpha /stop` with @alpha idle says “@alpha isn’t working.”
// With scripted Claude Code agents (no real turns), as in commands.spec.mjs.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let work;
let alpha;
let beta;
/** What each Claude Code agent was sent, and nothing else. */
const turns = [];

test.beforeAll(async () => {
  app = await startPostbox('commands-addressed', {
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(work);
    },
  });
  const { rt, store } = app;
  arrange.withAdapter(rt, {
    name: 'claude-code',
    async folderFor() {
      return work;
    },
    async deliver(session, message, ctx) {
      turns.push({ handle: session.handle, message, sessionId: session.id });
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_addr', name: 'Addressed', folder: work });
  alpha = rt.createPersona({ handle: 'alpha', backend: 'claude-code', permissionMode: 'ask' });
  beta = rt.createPersona({ handle: 'beta', backend: 'claude-code', permissionMode: 'ask' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A room of its own with @alpha and @beta and their commands, where `last` spoke last, open in the page. */
async function room(page, title, last) {
  const { rt, store } = app;
  const t = rt.createThread({ projectId: 'pr_addr', title, personaIds: [alpha.id, beta.id] });
  const [seA, seB] = arrange.sessionsIn(rt, t.id);
  arrange.offerCommands(rt, seA.id, [{ name: 'review', description: 'Review a file', argumentHint: '<file>', skill: true }, { name: 'compact' }]);
  arrange.offerCommands(rt, seB.id, [{ name: 'release-notes', description: 'Draft release notes', argumentHint: '[version]' }]);
  arrange.putThread(rt, { ...store.state.threads[t.id], lastSpeaker: (last === 'alpha' ? seA : seB).id });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.locator('#composer-input').focus();
  return { t, seA, seB };
}
const hint = (page) => page.locator('.composer .hint');
const sent = (t, text) => app.store.items(t.id).filter((i) => i.kind === 'user' && i.text === text);

test('#405 @alpha /compact compacts @alpha, though @beta spoke last, and sends no message', async ({ page }) => {
  const { t, seA, seB } = await room(page, 'Compact', 'beta');
  await page.keyboard.type('@alpha /compact');
  await expect(hint(page)).toContainText('Enter runs /compact for alpha');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => turns.some((x) => x.sessionId === seA.id && x.message.slash && x.message.text === '/compact'), { message: '/compact as @alpha’s turn' })
    .toBe(true);
  expect(
    turns.some((x) => x.sessionId === seB.id),
    'nothing reached @beta',
  ).toBe(false);
  expect(sent(t, '@alpha /compact'), 'no message with the command in it').toHaveLength(0);
  await expect(page.locator('#composer-input'), 'the composer is cleared').toHaveValue('');
});

test('#405 @beta /release-notes 2.1 runs @beta’s own command as its turn, though @alpha spoke last', async ({ page }) => {
  const { seA, seB } = await room(page, 'Skill', 'alpha');
  await page.keyboard.type('@beta /release-notes 2.1');
  await expect(hint(page)).toContainText('Enter runs /release-notes as beta’s turn');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => turns.find((x) => x.sessionId === seB.id && x.message.slash)?.message.text, { message: 'the command’s turn' })
    .toBe('/release-notes 2.1');
  const turn = turns.find((x) => x.sessionId === seB.id && x.message.slash);
  expect(turn.message.context, 'the command is the whole prompt').toBe(undefined);
  expect(
    turns.some((x) => x.sessionId === seA.id),
    'nothing reached @alpha',
  ).toBe(false);
});

test('#405 @alpha /mode opens @alpha’s persona sheet, not the last speaker’s', async ({ page }) => {
  await room(page, 'Mode', 'beta');
  await page.keyboard.type('@alpha /mode');
  await expect(hint(page)).toContainText('Enter runs /mode for alpha');
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet.locator('b', { hasText: 'alpha' })).toBeVisible();
  await expect(sheet.locator('b', { hasText: 'beta' })).toHaveCount(0);
});

test('#405 @alpha /release-notes, which @alpha doesn’t offer, says so and goes to @alpha as a message', async ({ page }) => {
  const { t, seA, seB } = await room(page, 'Missing', 'beta');
  await page.keyboard.type('@alpha /release-notes');
  await expect(hint(page)).toContainText('alpha has no /release-notes skill or command, so Enter sends this to it as a message');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent(t, '@alpha /release-notes').length, { message: 'the message' }).toBe(1);
  await expect.poll(() => turns.some((x) => x.sessionId === seA.id && !x.message.slash), { message: 'a message turn for alpha' }).toBe(true);
  expect(
    turns.some((x) => x.sessionId === seB.id || (x.sessionId === seA.id && x.message.slash)),
    'no command ran',
  ).toBe(false);
});

test('#405 @ghost /compact, a handle no agent here has, says so and goes to the last speaker as a message', async ({ page }) => {
  const { t, seA, seB } = await room(page, 'Ghost', 'beta');
  await page.keyboard.type('@ghost /compact');
  await expect(hint(page)).toContainText('No agent @ghost here, so Enter sends this to beta as a message');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent(t, '@ghost /compact').length, { message: 'the message' }).toBe(1);
  await expect.poll(() => turns.some((x) => x.sessionId === seB.id && !x.message.slash), { message: 'a message turn for beta' }).toBe(true);
  expect(
    turns.some((x) => [seA.id, seB.id].includes(x.sessionId) && x.message.slash),
    'no command ran in this room',
  ).toBe(false);
});

test('#405 @alpha /stop with @alpha idle says @alpha isn’t working, not that nothing is', async ({ page }) => {
  await room(page, 'Stop', 'beta');
  await page.keyboard.type('@alpha /stop');
  await expect(hint(page)).toContainText('Enter runs /stop for alpha');
  await page.keyboard.press('Enter');
  await expect(page.locator('#live')).toHaveText('alpha isn’t working.');
});
