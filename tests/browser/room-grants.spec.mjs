// Grant once (#852), driven with real clicks: a card for a gh label offers “Allow always in this room” and says what it
// saves; after that click, the agent’s next label on another PR runs with no card, made by Postbox, and its line says
// why; the Permissions panel lists the rule under “Saved in this room”, and Remove brings the card back. At 375 and
// 1280 px. With a scripted Claude Code agent and no model: a judge that was asked fails the spec.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let work;
const script = [];
/** Each gh argv Postbox ran. */
const ran = [];
let persona;
let calls = 0;

const label = (pr) => `gh pr edit ${pr} --repo HJeon139/postbox --add-label P2`;

test.beforeAll(async () => {
  app = await startPostbox('room-grants', {
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(join(work, '.claude'), { recursive: true });
    },
  });
  const { rt, store } = app;
  rt.judge = async () => {
    throw new Error('The judge was asked.');
  };
  rt.runGh = async (argv) => {
    ran.push(argv);
    return { status: 0, output: 'ok', argv, timedOut: false };
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
  store.emit('project', { id: 'pr_grant', name: 'Grant', folder: work, pushUrl: 'https://github.com/HJeon139/postbox.git' });
  persona = rt.createPersona({ handle: 'now', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** The agent’s Bash call, bound to the turn’s own tool_use as permission_prompt binds it (WJ-2). */
const asked = (ctx, command) => {
  const req = { tool: 'Bash', summary: `run ${command.split(' --')[0]}`, input: { command }, bound: true, toolUseId: `tu${++calls}` };
  ctx.toolUse({ id: req.toolUseId, name: 'Bash', input: req.input });
  return ctx.askPermission(req);
};
const idle = () => expect.poll(() => app.rt.turns.size, { message: 'the agent’s turn to end' }).toBe(0);

for (const width of [375, 1280])
  test(`grant once: Allow always in this room, the line it leaves, and Remove in the panel (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { rt, store } = app;
    const thread = rt.createThread({ projectId: 'pr_grant', title: `Grant ${width}`, personaIds: [persona.id] });
    const cards = () => store.items(thread.id).filter((i) => i.kind === 'permission');
    await page.goto(`${app.origin}/#/t/${thread.id}`);
    await synced(page, app);
    const replies = [];

    await test.step('the card offers the room rule, and says what it saves', async () => {
      script.push(async (ctx) => replies.push(await asked(ctx, label(940))));
      rt.sendMessage(thread.id, { text: 'Label them.' });
      const card = page.locator('.transcript .block', { hasText: 'run gh pr edit 940' });
      await expect(card).toContainText('Postbox will run gh pr edit for @now in this room without asking: only to this project’s repository');
      await synced(page, app);
      await card.getByRole('button', { name: 'Allow always in this room' }).click();
      await expect.poll(() => replies.length, { message: 'the answer to reach the agent' }).toBe(1);
      expect(replies[0].allow).toBe(true);
      await idle();
    });

    await test.step('the next label, on another PR, runs with no card, and its line says why', async () => {
      script.push(async (ctx) => replies.push(await asked(ctx, label(941))));
      rt.sendMessage(thread.id, { text: 'And the next.' });
      const line = page.locator('[data-allowed-call]');
      await expect(line).toHaveText(/Ran gh pr edit 941 .* for now without a card: you allowed gh pr edit for it in this room/);
      await expect.poll(() => replies.length).toBe(2);
      expect.soft(replies[1].allow, 'the agent’s own call never runs').toBe(false);
      expect.soft(ran.at(-1)).toEqual(['pr', 'edit', '941', '--repo', 'HJeon139/postbox', '--add-label', 'P2']);
      expect.soft(cards(), 'only the first card').toHaveLength(1);
      await idle();
    });

    await test.step('the panel lists it, and Remove brings the card back', async () => {
      await page.locator('header.topbar button[aria-label^="Actions for"]').click();
      await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
      const saved = page.locator('#perm-room');
      await expect(saved).toContainText('gh pr edit');
      await saved.getByRole('button', { name: 'Remove gh pr edit' }).click();
      await expect(saved).toContainText('None yet.');
      await expect.poll(() => store.state.threads[thread.id].grants?.length ?? 0).toBe(0);
      await page.keyboard.press('Escape');
      script.push(async (ctx) => replies.push(await asked(ctx, label(942))));
      rt.sendMessage(thread.id, { text: 'One more.' });
      const card = page.locator('.transcript .block', { hasText: 'run gh pr edit 942' });
      await expect(card.locator('.block-foot')).toBeVisible();
      await synced(page, app);
      await card.locator('.block-foot').getByRole('button', { name: 'Allow', exact: true }).click();
      await expect.poll(() => replies.length).toBe(3);
      expect.soft(cards()).toHaveLength(2);
      await idle();
    });
  });
