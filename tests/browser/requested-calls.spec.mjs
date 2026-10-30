// Writes the person asked for (#296), driven with real clicks: the person confirms a confirm that shows the exact
// commands, the agent’s gh pr create then runs without a card and leaves a line with the whole call, Stop on that line
// brings the card back for the next command the confirm showed, and the Permissions panel turns it off. With a
// scripted Claude Code agent (no real turns), and no model: a judge that was asked fails the spec.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let work;
const script = [];
let persona;
let thread;

const TITLE = 'feat(now): what each agent is doing now';
const CREATE = `gh pr create --title "${TITLE}" --body "Now shows what each agent is doing."`;
const COMMENT = 'gh pr comment 537 --body "CI is green."';
const CONFIRM = {
  id: 'push',
  type: 'confirm',
  version: 1,
  fallback: 'Push and open the PR?',
  title: 'Push Now and open its PR',
  statement: `Open the PR for Now, then say on #537 that CI is green:\n\n\`${CREATE}\`\n\n\`${COMMENT}\``,
  confirmLabel: 'Push 2d7c9a65',
};
const ask = (command) => ({ tool: 'Bash', summary: `run ${command.split(' --')[0]}`, input: { command } });

test.beforeAll(async () => {
  app = await startPostbox('requested-calls', {
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(join(work, '.claude'), { recursive: true });
    },
  });
  const { rt, store } = app;
  // No model here: a confirm that shows the exact command needs none, and a judge that was asked would fail the spec.
  rt.judge = async () => {
    throw new Error('The judge was asked.');
  };
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return work;
    },
    async deliver(_session, _message, ctx) {
      const step = script.shift();
      if (step) await step(ctx);
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_check', name: 'Check', folder: work });
  persona = app.rt.createPersona({ handle: 'now', backend: 'claude-code', permissionMode: 'auto', tools: ['shell'] });
  thread = app.rt.createThread({ projectId: 'pr_check', title: 'Requested calls', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const idle = () => expect.poll(() => app.rt.turns.size, { message: 'the agent’s turn to end' }).toBe(0);
const permissionCards = () => app.store.items(thread.id).filter((i) => i.kind === 'permission');

test('#296 a write the confirm shows word for word runs without a card; Stop brings the card back; the panel turns it off', async ({ page }) => {
  const { rt } = app;
  // On, as a new persona has it, whatever the other test left.
  rt.updatePersona(persona.id, { allowRequested: true });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const replies = [];

  await test.step('the confirmed PR is opened without a card, and the line says why', async () => {
    script.push(async (ctx) => ctx.tools.show_block({ block: CONFIRM }));
    rt.sendMessage(thread.id, { text: 'Get Now ready to merge.' });
    await idle();
    let stopped;
    const stop = new Promise((r) => {
      stopped = r;
    });
    script.push(async (ctx) => {
      replies.push(await ctx.askPermission(ask(CREATE)));
      await stop;
      replies.push(await ctx.askPermission(ask(COMMENT)));
    });
    await page.locator('.transcript .block', { hasText: 'Push Now and open its PR' }).getByRole('button', { name: 'Push 2d7c9a65' }).click();
    const line = page.locator('[data-allowed-call]');
    await expect(line).toHaveText(/Ran gh pr create --title .* for @now without a card: you confirmed “Push 2d7c9a65”/);
    expect.soft(replies[0]).toEqual({ allow: true });
    expect.soft(permissionCards(), 'no card').toHaveLength(0);
    await line.getByText('The whole call').click();
    await expect(line.locator('pre')).toHaveText(CREATE);

    await line.getByRole('button', { name: 'Stop these calls' }).click();
    await expect(line).toContainText('· Stopped');
    await expect(line.getByRole('button', { name: 'Stop these calls' })).toHaveCount(0);
    await expect(page.locator('.transcript')).toContainText('Stopped: @now’s next call asks you first');
    // The confirm showed this one too, so only Stop gives it a card.
    stopped();
    const card = page.locator('.transcript .block', { hasText: 'run gh pr comment 537' });
    await expect(card.locator('.block-foot')).toBeVisible();
    await synced(page, app);
    await card.locator('.block-foot').getByRole('button', { name: 'Allow', exact: true }).click();
    await expect.poll(() => replies.length, { message: 'the answer to reach the agent' }).toBe(2);
    expect.soft(permissionCards(), 'one card, for the call after Stop').toHaveLength(1);
    await idle();
  });

  await test.step('the Permissions panel turns it off for the persona', async () => {
    await page.locator('header.topbar button[aria-label^="Actions for"]').click();
    await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
    const box = page.getByRole('checkbox', { name: 'Writes you asked for run without a card' });
    await expect(box).toHaveAttribute('aria-checked', 'true');
    await box.click();
    await expect.poll(() => app.store.state.personas[persona.id].allowRequested).toBe(false);
    await expect(page.getByRole('checkbox', { name: 'Writes you asked for run without a card' })).toHaveAttribute('aria-checked', 'false');
  });
});

test('#296 with the setting off, a push the person asked for waits on a card that names its remote, and gh’s repository in the same command', async ({
  page,
}) => {
  const { rt } = app;
  rt.updatePersona(persona.id, { allowRequested: false });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const before = permissionCards().length;
  const replies = [];
  script.push(async (ctx) => {
    replies.push(await ctx.askPermission(ask('git push -u origin feat/now && gh pr create -R HJeon139/postbox --title Now --body Ready')));
  });
  rt.sendMessage(thread.id, { text: 'Push it to origin.' });
  const card = page.locator('.transcript .block', { hasText: 'run git push -u origin feat/now && gh pr create -R HJeon139/postbox' });
  await expect(card).toContainText(
    'This writes outside Postbox, to git (remote “origin”) and gh (repository “HJeon139/postbox”). Nothing is created, sent or changed until you allow it.',
  );
  await synced(page, app);
  await card.locator('.block-foot').getByRole('button', { name: 'Allow', exact: true }).click();
  await expect.poll(() => replies.length, { message: 'the answer to reach the agent' }).toBe(1);
  expect.soft(permissionCards()).toHaveLength(before + 1);
  await idle();
});
