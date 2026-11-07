// Writes the person confirmed, driven with real clicks: the person confirms a confirm whose `commands` field holds the
// exact commands (#852 slice 1a, which retired #296’s grant from a statement’s code), Postbox then runs the agent’s
// gh call itself with no card and leaves a line with the whole call, Stop on that line brings the card back for the
// next command the confirm held, and the Permissions panel turns off writes the person asked for in words. With a
// scripted Claude Code agent (no real turns), and no model: a judge that was asked fails the spec.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { confirmBodies } from '../../server/confirm-body.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let work;
const script = [];
let persona;
let thread;
/** Each gh argv Postbox ran. */
const ran = [];

const REPO = 'https://github.com/HJeon139/postbox.git';
const LABEL = 'gh pr edit 537 --repo HJeon139/postbox --add-label "ready for integrator"';
const UNLABEL = 'gh pr edit 537 --repo HJeon139/postbox --remove-label "changes requested"';
const CONFIRM = {
  id: 'label',
  type: 'confirm',
  version: 1,
  fallback: 'Label #537?',
  title: 'Label #537 ready',
  statement: 'Marks #537 ready for the integrator.',
  commands: [LABEL, UNLABEL],
  confirmLabel: 'Label #537',
};
let calls = 0;
const ask = (command) => ({ tool: 'Bash', summary: `run ${command.split(' --')[0]}`, input: { command } });
/** A Bash call as the stream shows it and permission_prompt passes it on: bound to the turn’s own tool_use (WJ-2). */
const asked = (ctx, command) => {
  const req = { ...ask(command), bound: true, toolUseId: `tu${++calls}` };
  ctx.toolUse({ id: req.toolUseId, name: 'Bash', input: req.input });
  return ctx.askPermission(req);
};

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
  // Postbox runs a confirmed gh call itself (server/confirm-run.mjs); here it records the words instead.
  rt.runGh = async (argv) => {
    ran.push(argv);
    return { status: 0, output: 'ok', argv, timedOut: false };
  };
  persona = app.rt.createPersona({ handle: 'now', backend: 'claude-code', permissionMode: 'auto', tools: ['shell'] });
  thread = app.rt.createThread({ projectId: 'pr_check', title: 'Requested calls', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const idle = () => expect.poll(() => app.rt.turns.size, { message: 'the agent’s turn to end' }).toBe(0);
const permissionCards = () => app.store.items(thread.id).filter((i) => i.kind === 'permission');

/** Postbox ran the confirmed gh call itself, with exactly its words, and the agent’s own call never ran. @param {any[]} replies */
async function ranByPostbox(line, replies) {
  await expect(line).toHaveText(/Ran gh pr edit 537 --repo .* for now without a card: you confirmed “Label #537”/);
  // The line is drawn before the answer reaches the agent, so wait for the answer too (the lagged run showed it).
  await expect.poll(() => replies.length, { message: 'the answer to reach the agent' }).toBe(1);
  const [reply] = replies;
  expect.soft(reply.allow, 'the agent’s own call never runs').toBe(false);
  expect.soft(reply.message).toMatch(/^Postbox ran this for you, as the person confirmed/);
  expect
    .soft(ran, 'Postbox ran exactly the confirmed words')
    .toEqual([['pr', 'edit', '537', '--repo', 'HJeon139/postbox', '--add-label', 'ready for integrator']]);
  expect.soft(permissionCards(), 'no card').toHaveLength(0);
  await line.getByText('The whole call').click();
  await expect(line.locator('pre')).toHaveText(LABEL);
}

test('#852 a command a confirm holds runs without a card; Stop brings the card back; the panel turns requests off', async ({ page }) => {
  const { rt, store } = app;
  // On, as a new persona has it, whatever the other test left.
  rt.updatePersona(persona.id, { allowRequested: true });
  // A confirmed gh call must post to the project’s own repository.
  store.emit('project', { ...store.state.projects.pr_check, pushUrl: REPO });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const replies = [];

  await test.step('the confirmed label is added without a card, and the line says why', async () => {
    script.push(async (ctx) => ctx.tools.show_block({ block: CONFIRM }));
    rt.sendMessage(thread.id, { text: 'Get Now ready to merge.' });
    await idle();
    let stopped;
    const stop = new Promise((r) => {
      stopped = r;
    });
    script.push(async (ctx) => {
      replies.push(await asked(ctx, LABEL));
      await stop;
      replies.push(await asked(ctx, UNLABEL));
    });
    await page.locator('.transcript .block', { hasText: 'Label #537 ready' }).getByRole('button', { name: 'Label #537' }).click();
    const line = page.locator('[data-allowed-call]');
    await ranByPostbox(line, replies);

    await line.getByRole('button', { name: 'Stop these calls' }).click();
    await expect(line).toContainText('· Stopped');
    await expect(line.getByRole('button', { name: 'Stop these calls' })).toHaveCount(0);
    await expect(page.locator('.transcript')).toContainText('Stopped: @now’s next call asks you first');
    // The confirm held this one too, so only Stop gives it a card.
    stopped();
    const card = page.locator('.transcript .block', { hasText: 'run gh pr edit 537' });
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

/**
 * Postbox’s own push, answering as told: it runs git, and tests/process/push-on-request.test.mjs runs it for real.
 * @param {any[]} made  each push it was asked to make
 */
const fakePushes = (made) => ({
  consequence: async ({ url }) =>
    url
      ? {
          branch: 'feat/now',
          current: 'feat/now',
          sha: '2d7c9a65'.padEnd(40, '0'),
          objects: '/x',
          url,
          sentence: `commit 2d7c9a6 lands on branch feat/now of ${url}, with no force`,
        }
      : null,
  run: async (p) => {
    made.push(p);
    return { ok: true };
  },
});

test('#562 a push the person confirmed is Postbox’s own, to the repository they set on the project, and the line says what landed where', async ({ page }) => {
  const { rt } = app;
  rt.updatePersona(persona.id, { allowRequested: true });
  const PUSH = 'git push -u origin feat/now';
  const made = [];
  rt.pushes = fakePushes(made);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);

  await test.step('the person sets the project’s repository in Settings', async () => {
    await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Projects' }).click();
    const row = settings.locator('li', { hasText: 'Check' });
    await row.getByLabel('Repository to push to').fill(REPO);
    await row.getByRole('button', { name: 'Save repository' }).click();
    await expect.poll(() => app.store.state.projects.pr_check.pushUrl).toBe(REPO);
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
  });

  await test.step('the agent’s git push answers no, Postbox pushes, and the line says what landed where', async () => {
    const before = permissionCards().length;
    const block = { ...CONFIRM, id: 'push-now', title: 'Push Now', statement: 'Push Now:', commands: [PUSH], confirmLabel: 'Push feat/now' };
    // As server/mcp.mjs shows it: the push pinned to what it would land, before the tool runs (confirm-body.mjs).
    script.push(async (ctx) => ctx.tools.show_block({ block }, await confirmBodies(rt, rt.sessionsIn(thread.id)[0].id, 'show_block', { block })));
    rt.sendMessage(thread.id, { text: 'Get Now ready.' });
    await idle();
    const replies = [];
    script.push(async (ctx) => {
      replies.push(await asked(ctx, PUSH));
    });
    await page.locator('.transcript .block', { hasText: 'Push Now:' }).getByRole('button', { name: 'Push feat/now' }).click();
    const line = page.locator('[data-allowed-call]').last();
    await expect(line).toHaveText(
      /Pushed 2d7c9a6 to feat\/now of https:\/\/github\.com\/HJeon139\/postbox\.git for now, in place of its own git push: you confirmed “Push feat\/now”/,
    );
    await expect.poll(() => replies.length, { message: 'the answer to reach the agent' }).toBe(1);
    expect.soft(replies[0].allow, 'the agent’s own push never runs').toBe(false);
    expect.soft(replies[0].message).toMatch(/^Postbox pushed this for you, as the person asked/);
    expect.soft(made.map((p) => [p.url, p.branch])).toEqual([[REPO, 'feat/now']]);
    expect.soft(permissionCards(), 'no card').toHaveLength(before);
    await idle();
  });
  delete rt.pushes;
});
