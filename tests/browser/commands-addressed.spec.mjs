// Commands aimed at one agent with `@handle /name` (#405), typed as a person types them, in a room with two agents
// where the other one spoke last:
// - `@alpha /compact` runs /compact as @alpha’s turn, and nothing goes out as a message;
// - `@beta /release-notes 2.1` runs @beta’s own command as its turn, with `/release-notes 2.1` as the whole prompt;
// - `@alpha /mode` opens @alpha’s persona sheet, not the last speaker’s;
// - `/effort low` says Postbox’s /effort takes no argument, opens the last speaker’s sheet, and sends nothing (#546);
// - `/stop alpha` says Postbox’s /stop takes no argument, and Enter sends nothing (#546), as does `/effort low` with a file;
// - `/compact keep the plan`, which @alpha offers, says it runs as @alpha’s turn, not Postbox’s /compact (#546);
// - `@alpha /release-notes`, which @alpha doesn’t offer, says so before it’s sent, and goes to @alpha as a message;
// - `@ghost /compact`, a handle no agent here has, says so too, and goes to the last speaker as a message;
// - `@alpha /stop` with @alpha idle says “@alpha isn’t working.”
// With scripted Claude Code agents (no real turns), as in commands.spec.mjs.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { plainOf } from '../turn-parts.mjs';
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
    async deliver(session, given, ctx) {
      // The plain message the turn answers: an input’s batch, as its turn was asked (#1427).
      const message = plainOf(app.rt, session.id, given);
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

// #546: `/effort low`, typed as a CLI takes it, went to the agent as a message and started a turn, unannounced.
/** Sends a message after the line under test and waits for it, so a message or turn the line started has had time to show. */
async function sendAfter(page, t) {
  await page.locator('#composer-input').fill('after');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent(t, 'after').length, { message: 'the message sent after' }).toBe(1);
}
const turnsFor = (typed) => turns.filter((x) => JSON.stringify(x.message).includes(typed));

test('#546 /effort low, which Postbox’s /effort doesn’t take, says so and opens the reply agent’s sheet, sending nothing', async ({ page }) => {
  const { t } = await room(page, 'Effort', 'beta');
  await page.keyboard.type('/effort low');
  await expect(hint(page)).toContainText('/effort takes no argument here, so Enter runs it for beta without “low”');
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet.locator('b', { hasText: 'beta' })).toBeVisible();
  await page.keyboard.press('Escape');
  await sendAfter(page, t);
  expect(sent(t, '/effort low'), 'no message').toEqual([]);
  expect(turnsFor('/effort'), 'no turn').toEqual([]);
});

test('#546 /stop alpha, which Postbox’s /stop doesn’t take, says so and sends nothing, keeping the draft', async ({ page }) => {
  const { t } = await room(page, 'Stop with an argument', 'beta');
  await page.keyboard.type('/stop alpha');
  await expect(hint(page)).toContainText('/stop takes no argument here, so Enter sends nothing. Remove “alpha” to run it');
  await page.keyboard.press('Enter');
  await expect(page.locator('#composer-input'), 'the draft stays').toHaveValue('/stop alpha');
  await sendAfter(page, t);
  expect(sent(t, '/stop alpha'), 'no message').toEqual([]);
  expect(turnsFor('/stop'), 'no turn').toEqual([]);
});

test('#546 a file attached after /effort low is typed: the hint changes to say Enter sends nothing, and it does', async ({ page }) => {
  const { t } = await room(page, 'With a file', 'beta');
  await page.keyboard.type('/effort low');
  await expect(hint(page)).toContainText('/effort takes no argument here, so Enter runs it for beta without “low”');
  await page.locator('.composer input[type=file][multiple]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes') });
  await expect(page.locator('.composer .attachments .att')).toHaveText(/^notes\.txt · \d/);
  await expect(hint(page)).toContainText('/effort takes no argument here, so Enter sends nothing. Remove “low” and the attached files to run it');
  await page.locator('#composer-input').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#composer-input'), 'the draft stays').toHaveValue('/effort low');
  await expect(page.locator('.composer .attachments .att'), 'and so does the file').toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Settings' }), 'no settings opened').toHaveCount(0);
  // Without the file, the hint goes back, and the agent’s /compact no longer promises a turn with a file there.
  await page.locator('#composer-input').fill('/compact keep the plan');
  await expect(hint(page), 'an agent’s command with a file goes as a message, so no turn is promised').not.toContainText('alpha’s turn');
  await page.locator('.composer .attachments .att button').first().click();
  await expect(page.locator('.composer .attachments .att')).toHaveCount(0);
  await expect(hint(page), 'the file removed, the agent’s command runs as its turn').toContainText('Enter runs /compact as alpha’s turn');
  // What the hint said to do: without “low” and the file, Enter runs /effort, and nothing is sent.
  await page.locator('#composer-input').fill('/effort');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Settings' }).locator('b', { hasText: 'beta' })).toBeVisible();
  await page.keyboard.press('Escape');
  await sendAfter(page, t);
  expect(sent(t, '/effort low').concat(sent(t, '/effort')), 'no message').toEqual([]);
  expect(turnsFor('/effort'), 'no turn').toEqual([]);
});

test('#546 /compact keep the plan, which only @alpha offers, names whose turn it starts, since Postbox has a /compact too', async ({ page }) => {
  await room(page, 'Shadowed', 'beta');
  await page.keyboard.type('/compact keep the plan');
  await expect(hint(page)).toContainText('Enter runs /compact as alpha’s turn');
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
