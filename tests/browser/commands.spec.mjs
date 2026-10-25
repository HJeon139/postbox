// Commands in the composer (#67), driven with real key presses and clicks:
// - `/` opens the command menu, by typing and with the Commands button; arrows and Enter pick, Escape closes;
// - a Postbox command runs without a turn (/mode, /effort, /rename);
// - an agent’s skill, picked in a room with two agents, fills `/name `, shows its argument hint, and runs as that
//   agent’s turn;
// - `!` runs a command in the conversation’s folder and shows its output, exit code and duration; a failing command
//   shows its exit code; Stop stops one; the next turn of an agent reads it, and nothing woke it; in a topic thread,
//   `!` says before sending that it won’t run there (#104);
// - a `!` request without the page’s token gets 403.
// With scripted Claude Code agents (no real turns), in a room of their own for each test, and real commands run
// through your shell in a temp folder. Moved from tools/check-commands.mjs (#303).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let work;
let alpha;
let beta;
/** What each Claude Code agent was sent, and nothing else. */
const turns = [];

test.beforeAll(async () => {
  app = await startPostbox('commands', {
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(work);
      await writeFile(join(work, 'hello.txt'), 'hello from the folder\n');
    },
  });
  const { rt, store } = app;
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return work;
    },
    async deliver(session, message, ctx) {
      turns.push({ handle: session.handle, message, sessionId: session.id });
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_cmd', name: 'Commands', folder: work });
  alpha = rt.createPersona({ handle: 'alpha', backend: 'claude-code', permissionMode: 'ask' });
  beta = rt.createPersona({ handle: 'beta', backend: 'claude-code', permissionMode: 'ask' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A room of its own with @alpha and @beta, and their skills and commands, open in the page. */
async function room(page, title) {
  const { rt } = app;
  const t = rt.createThread({ projectId: 'pr_cmd', title, personaIds: [alpha.id, beta.id] });
  const [seA, seB] = rt.sessionsIn(t.id);
  // As an init or the SDK’s supportedCommands() would give them.
  rt.recordCommands(seA.id, [{ name: 'review', description: 'Review a file', argumentHint: '<file>', skill: true }, { name: 'compact' }]);
  rt.recordCommands(seB.id, [{ name: 'release-notes', description: 'Draft release notes', argumentHint: '[version]' }]);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.locator('#composer-input').focus();
  return { t, seA, seB };
}
const composer = (page) => page.locator('#composer-input');
const words = async (locator) => (await locator.allInnerTexts()).join(' ').replace(/\s+/g, ' ').trim();
const commandCard = (page, cmd) => page.locator('.transcript .cmd-block', { hasText: `! ${cmd}` });
/** Runs a command with !, as a person types it, and waits for its exit code. */
async function run(page, cmd, exit) {
  await composer(page).focus();
  await page.keyboard.type(`!${cmd}`);
  await page.keyboard.press('Enter');
  await expect(commandCard(page, cmd), `${cmd} to finish`).toContainText(`Exit ${exit}`);
}

// ── / ───────────────────────────────────────────────────────────────────────────────────

test('#67 typing / opens the menu: Postbox’s commands, then each agent’s, grouped; Escape closes it', async ({ page }) => {
  await room(page, 'Menu');
  await page.keyboard.type('/');
  await expect(page.locator('#slash-list')).toBeVisible();
  const all = await words(page.locator('#slash-list'));
  expect(all).toMatch(/POSTBOX.*\/permissions.*\/mode.*\/model.*\/effort.*\/add-dir.*\/mcp.*\/compact.*\/stop.*\/rename/i);
  // A session is archived only with its conversation (#320).
  expect(all).not.toMatch(/\/archive/);
  expect(all).toMatch(/@alpha’s skills and commands \/review <file> Review a file/i);
  expect(all).toMatch(/@beta’s skills and commands \/release-notes \[version\] Draft release notes/i);
  // compact is Postbox’s here (it runs /compact as the agent’s turn), so it isn’t listed twice.
  expect((all.match(/\/compact/g) ?? []).length).toBe(1);
  await expect(composer(page)).toHaveAttribute('aria-activedescendant', 'slash-0');
  await page.keyboard.press('ArrowDown');
  await expect(composer(page)).toHaveAttribute('aria-activedescendant', 'slash-1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#slash-list')).toHaveCount(0);
  await expect(composer(page), 'focus stays in the composer').toBeFocused();
});

test('#67 the Commands button opens the same menu', async ({ page }) => {
  await room(page, 'Button');
  await page.locator('.composer').getByRole('button', { name: 'Commands', exact: true }).click();
  await expect(page.locator('#slash-list')).toBeVisible();
  await expect(composer(page)).toHaveValue('/');
  await expect(composer(page)).toBeFocused();
});

test('#67 /mode runs without a turn: the choice changes the agent’s mode and says when it applies', async ({ page }) => {
  const { rt, store } = app;
  const { t, seA } = await room(page, 'Mode');
  const before = turns.length;
  try {
    await page.keyboard.type('/mo');
    await expect(page.locator('#slash-list')).toContainText('/mode');
    await page.keyboard.press('Enter');
    await page.locator('.dialog [aria-label="Permission mode"] button', { hasText: 'Accept edits' }).click();
    await expect(page.locator('.dialog .perm-status')).toContainText('uses Accept edits, in every conversation, from its next turn');
    const who = store.state.sessions[store.state.threads[t.id].lastSpeaker ?? seA.id]?.personaId ?? alpha.id;
    expect(store.state.personas[who].permissionMode).toBe('acceptEdits');
    expect(turns.length, 'no turn').toBe(before);
    await expect(composer(page), 'the composer is cleared').toHaveValue('');
  } finally {
    for (const p of [alpha, beta]) rt.updatePersona(p.id, { permissionMode: 'ask' });
  }
});

test('#67 /effort sets this conversation’s effort; /rename opens the rename sheet', async ({ page }) => {
  const { rt, store } = app;
  const { t } = await room(page, 'Effort');
  await page.keyboard.type('/effort');
  await page.keyboard.press('Enter');
  await page.locator('.dialog [aria-label="Effort"] button', { hasText: /^High$/ }).click();
  await expect(page.locator('.dialog .perm-status')).toContainText('uses High in this conversation, from its next turn');
  expect(rt.sessionsIn(t.id).some((se) => store.state.sessions[se.id].personaSnapshot.effort === 'high')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog')).toHaveCount(0);
  await composer(page).focus();
  await page.keyboard.type('/ren');
  await page.keyboard.press('Enter');
  await expect(page.locator('.dialog input'), 'the rename sheet').toBeVisible();
  await expect(page.locator('.dialog .d-head')).toContainText('Rename');
});

test('#67 an agent’s skill: picking it fills /name and its hint, addresses that agent in a room, and runs as its turn', async ({ page }) => {
  const { seB } = await room(page, 'Skill');
  await page.keyboard.type('/release');
  await page.keyboard.press('Enter');
  await expect(composer(page)).toHaveValue('/release-notes ');
  await expect(page.locator('.composer .hint')).toContainText('Enter runs /release-notes [version] as @beta’s turn');
  await page.keyboard.type('2.1');
  await page.keyboard.press('Enter');
  await expect.poll(() => turns.some((x) => x.sessionId === seB.id && x.message.slash), { message: 'the skill’s turn' }).toBe(true);
  const turn = turns.find((x) => x.sessionId === seB.id && x.message.slash);
  expect(turn.handle).toBe('beta');
  expect(turn.message.text).toBe('/release-notes 2.1');
  expect(turn.message.context, 'the skill is the whole prompt').toBe(undefined);
  await expect(page.locator('.transcript .me-card', { hasText: '/release-notes 2.1' }), 'the line in the transcript').toBeVisible();
});

// ── ! ───────────────────────────────────────────────────────────────────────────────────

test('#67 ! runs a command in the conversation’s folder, with its output, exit code and duration', async ({ page }) => {
  await room(page, 'Runs');
  const before = turns.length;
  await page.keyboard.type('!cat hello.txt && pwd');
  await expect(page.locator('.composer .hint')).toContainText(`Runs in ${work} as you`);
  await page.keyboard.press('Enter');
  const card = commandCard(page, 'cat hello.txt && pwd');
  await expect(card, 'the command to finish').toContainText('Exit 0');
  const said = await words(card);
  expect(said).toMatch(/hello from the folder/);
  expect(said).toMatch(/pb-spec-commands-.*work/);
  expect(said).toMatch(/Exit 0 · \d+\.\d s/);
  expect(turns.length, 'running it woke no agent').toBe(before);
});

test('#67 a failing command shows its exit code', async ({ page }) => {
  await room(page, 'Fails');
  await run(page, 'echo oops >&2; exit 3', 3);
  await expect(commandCard(page, 'echo oops >&2; exit 3')).toContainText('oops');
  await expect(commandCard(page, 'echo oops >&2; exit 3')).toHaveClass(/\bcmd-failed\b/);
});

test('#67 Stop stops a running command', async ({ page }) => {
  await room(page, 'Stops');
  await page.keyboard.type('!sleep 30');
  await page.keyboard.press('Enter');
  await commandCard(page, 'sleep 30').getByRole('button').click();
  await expect(commandCard(page, 'sleep 30')).toContainText('Stopped by you');
});

test('#67 the next turn reads what ran, with its output', async ({ page }) => {
  const { t, seA } = await room(page, 'Reads');
  await run(page, 'cat hello.txt && pwd', 0);
  await run(page, 'echo oops >&2; exit 3', 3);
  app.rt.sendMessage(t.id, { text: '@alpha what did that print?' });
  await expect.poll(() => turns.some((x) => x.sessionId === seA.id && x.message.text?.includes('what did that print')), { message: 'alpha’s turn' }).toBe(true);
  const context = turns.find((x) => x.sessionId === seA.id && x.message.text?.includes('what did that print')).message.context.join('\n');
  expect(context).toMatch(/You ran `cat hello\.txt && pwd` in .* \(it exited with 0\)\. Output:\n```\nhello from the folder/);
  expect(context).toMatch(/You ran `echo oops >&2; exit 3` in .* \(it exited with 3\)/);
});

test('#104 ! in a topic thread says before sending that it won’t run there, and goes as a message', async ({ page }) => {
  const { rt, store } = app;
  const { t, seA } = await room(page, 'Topic');
  const root = rt.addItem(t.id, { kind: 'agent', sessionId: seA.id, personaId: seA.personaId, handle: 'alpha', text: 'Here.', status: 'done' });
  const { threadId } = rt.startTopic(t.id, root.id);
  // Only the hash changes, so the page doesn’t load again: the thread must have reached it first, or it doesn’t know it.
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}/side/${threadId}`);
  await synced(page, app);
  const side = page.locator('#side-input');
  const hint = side.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " composer ")][1]').locator('.hint');
  await side.click();
  await page.keyboard.type('!gh --help');
  await expect(hint).toContainText('! runs commands only in the conversation’s own composer. Here, this goes to the agent as a message.');
  // Back to a message, the hint is the thread’s own again.
  await page.keyboard.press('Home');
  await page.keyboard.press('Delete');
  await expect(side).toHaveValue('gh --help');
  await expect(hint).not.toContainText('runs commands only');
  expect(store.items(threadId).filter((i) => i.kind === 'command').length, 'nothing ran in the thread').toBe(0);
});

test('#67 a ! request without the page’s token gets 403, and nothing runs', async ({ page }) => {
  const { store } = app;
  const { t } = await room(page, 'Token');
  const count = store.items(t.id).filter((i) => i.kind === 'command').length;
  const r = await fetch(`${app.origin}/api/threads/${t.id}/shell`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'touch pwned' }),
  });
  expect(r.status).toBe(403);
  expect(store.items(t.id).filter((i) => i.kind === 'command').length).toBe(count);
});
