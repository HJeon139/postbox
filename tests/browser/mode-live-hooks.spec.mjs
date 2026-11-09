// What the panels say when a permission mode changes during a turn, about that turn’s hooks and why it keeps its mode
// (#1030). A turn loads the person’s hooks when it starts, in Auto and Run everything only (#806), so a turn that
// started in Ask me and switches live to Auto runs without them until it ends, and a turn that started in Auto keeps
// them, and its mode, when Ask me is chosen: Postbox refuses that switch on the Agent SDK (switchesLive), and the
// Claude Code CLI can’t change a running turn at all. Scripted agents whose turns hold until released, the Agent SDK’s
// with its real live control, and a hook in the user settings of the spec’s own home.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { liveControl } from '../../server/adapters/agent-sdk.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Each agent’s conversation, by its handle. @type {Record<string, string>} */
const threads = {};
/** Lets an agent’s held turn end, by its handle. @type {Map<string, () => void>} */
const release = new Map();

const KEPT = 'Postbox doesn’t tighten a running turn’s mode, since your hooks or Run everything could still approve a call there without your card.';
const HOOKS_LATER = 'though your hooks load only from its next turn';
const OFF_TAIL = 'They run in Auto and Run everything, and when you use Claude Code yourself.';
const ON_TAIL = 'One that allows a call also skips your ask rules, this conversation’s included, as in your terminal.';
const stillRun = (handle, mode) =>
  `These don’t run in ${handle}’s Postbox turns in ${mode} mode from its next turn: its running turn started with them, and runs them until it ends. ${OFF_TAIL}`;
const dontRun = (handle, mode) => `These don’t run in ${handle}’s Postbox turns in ${mode} mode. ${OFF_TAIL}`;
const notYet = (handle, mode) =>
  `In ${mode} mode, these run in ${handle}’s Postbox turns too, from its next turn: its running turn started without them. ${ON_TAIL}`;

/** A turn that holds until released or stopped. */
const hold = (ctx) =>
  new Promise((r) => {
    release.set(ctx.persona.handle, () => r(undefined));
    ctx.signal.addEventListener('abort', () => r(undefined));
  });

test.beforeAll(async () => {
  let work = '';
  app = await startPostbox('mode-live-hooks', {
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(join(root, '.claude'), { recursive: true });
      await mkdir(work, { recursive: true });
      const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/audit-bash' }] }] };
      await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks }));
    },
  });
  const { rt, store } = app;
  // The Agent SDK, with its real live control on a query that takes every mode it’s given.
  rt.adapters.register({
    name: 'agent-sdk',
    async folderFor() {
      return work;
    },
    async deliver(_session, _message, ctx) {
      ctx.control?.(liveControl({ setPermissionMode: async () => {} }, ctx.persona.permissionMode));
      ctx.status({ state: 'tool', currentStep: 'Writing the notes' });
      await hold(ctx);
    },
  });
  // The Claude Code CLI, which can’t change a running turn’s mode.
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return work;
    },
    async deliver(_session, _message, ctx) {
      ctx.status({ state: 'tool', currentStep: 'Running the tests' });
      await hold(ctx);
    },
  });
  store.emit('project', { id: 'pr_live', name: 'Live', folder: work });
  for (const [handle, backend, permissionMode] of [
    ['drafter', 'agent-sdk', 'ask'],
    ['keeper', 'agent-sdk', 'auto'],
    ['tightener', 'agent-sdk', 'auto'],
    ['cli', 'claude-code', 'auto'],
  ]) {
    const p = rt.createPersona({ handle, backend, permissionMode, tools: ['shell'] });
    threads[handle] = rt.createThread({ projectId: 'pr_live', title: handle, personaIds: [p.id] }).id;
    rt.sendMessage(threads[handle], { text: `@${handle} get going` });
  }
});
test.afterAll(async () => {
  for (const r of release.values()) r();
  await app?.stop();
});
failOnPageErrors(test);

/** Opens `handle`’s conversation once its turn is running. */
async function open(page, handle) {
  await expect.poll(() => release.has(handle), { message: `${handle} at work` }).toBe(true);
  await page.goto(`${app.origin}/#/t/${threads[handle]}`);
  await synced(page, app);
}

/** Opens the permissions panel from the conversation’s ⋯. */
async function openPanel(page) {
  await page.locator('header.topbar button[aria-label^="Actions for"]').click();
  await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('#perm-hooks'), 'the hooks section').toBeVisible();
  return dialog;
}

/** Picks a mode in /mode’s choice. */
async function slashMode(page, name) {
  await page.locator('#composer-input').focus();
  await page.keyboard.type('/mo');
  await expect(page.locator('#slash-list')).toContainText('/mode');
  await page.keyboard.press('Enter');
  const dialog = page.locator('.dialog');
  await dialog.getByRole('radiogroup', { name: 'Permission mode' }).getByRole('radio', { name, exact: true }).click();
  return dialog;
}

test('#1030 Ask me to Auto live: each panel says the running turn changed, and that the hooks load from its next turn', async ({ page }) => {
  await open(page, 'drafter');
  const dialog = await openPanel(page);
  await dialog.locator('[aria-label="Mode"] button', { hasText: 'Auto' }).click();
  await expect.soft(dialog.locator('.perm-status')).toHaveText(`drafter is in Auto mode now, in its running turn too, ${HOOKS_LATER}.`);
  await expect.soft(dialog.locator('#perm-hooks p.help').first()).toHaveText(notYet('drafter', 'Auto'));
  await page.keyboard.press('Escape');
  const choice = await slashMode(page, 'Run everything');
  await expect
    .soft(choice.locator('.perm-status'))
    .toHaveText(`drafter uses Run everything, in every conversation, from now: its running turn changed too, ${HOOKS_LATER}.`);
  await page.keyboard.press('Escape');
  await page.locator('.rail .agent-row .agent-btn', { hasText: 'drafter' }).click();
  const quick = page.locator('.backdrop .dialog.quick');
  await quick.locator('[role=radiogroup][aria-label^="Permission mode"]').getByRole('radio', { name: /^Auto/ }).click();
  await expect
    .soft(quick.locator('.perm-status'))
    .toHaveText(`Permission mode: Auto for drafter in every conversation, from now: its running turn changed too, ${HOOKS_LATER}.`);
});

test('#1030 Auto to Ask me on the Agent SDK: the panel says Postbox keeps the mode, and the hooks run until the turn ends', async ({ page }) => {
  await open(page, 'keeper');
  let dialog = await openPanel(page);
  // In Auto, its running turn loaded the hooks, so the note says nothing of a next turn.
  await expect.soft(dialog.locator('#perm-hooks p.help').first()).toHaveText(`In Auto mode, these run in keeper’s Postbox turns too. ${ON_TAIL}`);
  await dialog.locator('[aria-label="Mode"] button', { hasText: 'Ask me' }).click();
  await expect.soft(dialog.locator('.perm-status')).toHaveText(`keeper is in Ask me mode from its next turn, or now if you stop it: ${KEPT}`);
  await expect.soft(dialog.locator('#perm-hooks p.help').first()).toHaveText(stillRun('keeper', 'Ask me'));
  await page.keyboard.press('Escape');
  // Once the turn ends, its hooks have gone with it.
  release.get('keeper')?.();
  await expect.poll(() => Object.values(app.rt.s.sessions).some((x) => x.threadId === threads.keeper && app.rt.turns.has(x.id))).toBe(false);
  dialog = await openPanel(page);
  await expect.soft(dialog.locator('#perm-hooks p.help').first()).toHaveText(dontRun('keeper', 'Ask me'));
});

test('#1030 Auto, then Run everything live, then Ask me: each panel says the turn keeps its mode until it ends, and why', async ({ page }) => {
  await open(page, 'tightener');
  let choice = await slashMode(page, 'Run everything');
  await expect.soft(choice.locator('.perm-status')).toHaveText('tightener uses Run everything, in every conversation, from now: its running turn changed too.');
  await page.keyboard.press('Escape');
  choice = await slashMode(page, 'Ask me');
  await expect
    .soft(choice.locator('.perm-status'))
    .toHaveText(`tightener uses Ask me, in every conversation, from its next turn, or now if you stop it: ${KEPT}`);
  await page.keyboard.press('Escape');
  await page.locator('.rail .agent-row .agent-btn', { hasText: 'tightener' }).click();
  const quick = page.locator('.backdrop .dialog.quick');
  await quick
    .locator('[role=radiogroup][aria-label^="Permission mode"]')
    .getByRole('radio', { name: /^Accept edits/ })
    .click();
  await expect
    .soft(quick.locator('.perm-status'))
    .toHaveText(
      `Permission mode: Accept edits for tightener in every conversation, from their next turns. Its running turn here keeps its mode until it ends: ${KEPT} Stop it to apply this now.`,
    );
  await expect.soft(quick.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
});

test('#1030 Auto to Ask me on the CLI: the panel keeps Claude Code’s reason, and says the hooks run until the turn ends', async ({ page }) => {
  await open(page, 'cli');
  const dialog = await openPanel(page);
  await dialog.locator('[aria-label="Mode"] button', { hasText: 'Ask me' }).click();
  await expect.soft(dialog.locator('.perm-status')).toHaveText('cli is in Ask me mode from its next turn: Claude Code can’t change a turn that’s running.');
  await expect.soft(dialog.locator('#perm-hooks p.help').first()).toHaveText(stillRun('cli', 'Ask me'));
  await page.keyboard.press('Escape');
  const choice = await slashMode(page, 'Accept edits');
  await expect
    .soft(choice.locator('.perm-status'))
    .toHaveText('cli uses Accept edits, in every conversation, from its next turn; Claude Code can’t change a turn that’s running.');
});
