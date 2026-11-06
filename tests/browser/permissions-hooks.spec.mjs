// The permissions panel names the PreToolUse hooks in the settings files an agent reads (#817): Postbox’s own settings
// turn them off in every mode but Run everything, so the panel says which won’t run, and that hooks the person’s
// organization manages still do. A hook’s command is the person’s data, shown as text. Scripted Claude Code agents,
// one per state, working in temp folders, with a home of their own for the user settings.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Each state’s conversation, by its agent’s handle. @type {Record<string, string>} */
const threads = {};
let manyFile = '';

const MARKUP = 'echo "<b id=hook-markup>allow</b>" && exit 0';
const USER_ROW = 'Bash ~/bin/audit-bash from your user settings';
const PROJECT_ROW = `Bash ${MARKUP} from the project’s shared settings`;
const OFF =
  'In every mode but Run everything, Postbox turns off hooks from settings files, plugin hooks and your custom status line for its own turns, since a hook that approves a tool call would skip the ask rules and the permission card. Hooks your organization manages still run, and one of those can still approve a call without asking you.';
const ISOLATED = 'It’s isolated, so it doesn’t read the hooks in your user settings.';
const dontRun = (handle) => `These don’t run in @${handle}’s Postbox turns, except in Run everything mode. They still run when you use Claude Code yourself.`;

test.beforeAll(async () => {
  /** @type {Record<string, string>} */
  const folders = {};
  app = await startPostbox('permissions-hooks', {
    // A hook in the user’s settings, and one with markup in its command in the project’s; another folder with 55.
    async prepare(root) {
      const hooks = (...commands) =>
        JSON.stringify({ hooks: { PreToolUse: commands.map((command) => ({ matcher: 'Bash', hooks: [{ type: 'command', command }] })) } });
      folders.work = join(root, 'work');
      folders.many = join(root, 'many');
      for (const dir of [join(root, '.claude'), join(folders.work, '.claude'), join(folders.many, '.claude')]) await mkdir(dir, { recursive: true });
      await writeFile(join(root, '.claude', 'settings.json'), hooks('~/bin/audit-bash'));
      await writeFile(join(folders.work, '.claude', 'settings.json'), hooks(MARKUP));
      manyFile = join(folders.many, '.claude', 'settings.json');
      await writeFile(manyFile, hooks(...Array.from({ length: 55 }, (_, i) => `hook ${i}`)));
    },
  });
  const { rt, store } = app;
  rt.adapters.register({
    name: 'claude-code',
    async folderFor(persona) {
      return folders[persona.handle] ?? folders.work;
    },
    async deliver(_session, _message, ctx) {
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_hooks', name: 'Hooks', folder: folders.work });
  for (const [handle, setup] of [
    ['coder', { permissionMode: 'auto' }],
    ['runner', { permissionMode: 'bypass' }],
    ['loner', { permissionMode: 'auto', usesHostSetup: false }],
    ['many', { permissionMode: 'auto', usesHostSetup: false }],
  ]) {
    const persona = rt.createPersona({ handle, backend: 'claude-code', ...setup });
    threads[handle] = rt.createThread({ projectId: 'pr_hooks', title: handle, personaIds: [persona.id] }).id;
  }
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** Opens the panel from `handle`’s conversation’s ⋯, and returns its hooks section. */
async function openHooks(page, handle) {
  await page.goto(`${app.origin}/#/t/${threads[handle]}`);
  await synced(page, app);
  await page.locator('header.topbar button[aria-label^="Actions for"]').click();
  await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
  const hooks = page.locator('.dialog #perm-hooks');
  await expect(hooks, 'the hooks section').toBeVisible();
  return hooks;
}

test('#817 the panel names each PreToolUse hook as text, and says it won’t run in Postbox turns', async ({ page }) => {
  const hooks = await openHooks(page, 'coder');
  await expect.soft(hooks.locator('li')).toHaveText([USER_ROW, PROJECT_ROW]);
  await expect.soft(hooks.locator('p.help')).toHaveText([dontRun('coder'), OFF]);
  await expect.soft(hooks.locator('p.err'), 'no file failed').toHaveCount(0);
});

test('#817 a hook’s command with markup in it shows literally, never as HTML', async ({ page }) => {
  const hooks = await openHooks(page, 'coder');
  await expect.soft(hooks.locator('li code.perm-rule', { hasText: 'echo' })).toHaveText(MARKUP);
  await expect.soft(page.locator('#hook-markup'), 'a hook’s command is text, never markup').toHaveCount(0);
  await expect.soft(hooks.locator('b'), 'no element from the command').toHaveCount(0);
});

test('#817 in Run everything mode, the panel says the hooks run', async ({ page }) => {
  const hooks = await openHooks(page, 'runner');
  await expect.soft(hooks.locator('li')).toHaveText([USER_ROW, PROJECT_ROW]);
  await expect.soft(hooks.locator('p.help')).toHaveText(['In Run everything mode, these run in @runner’s Postbox turns too.', OFF]);
});

test('#817 an Isolated agent’s panel lists the project’s hooks only, and says it doesn’t read the user’s', async ({ page }) => {
  const hooks = await openHooks(page, 'loner');
  await expect.soft(hooks.locator('li')).toHaveText([PROJECT_ROW]);
  await expect.soft(hooks.locator('p.help')).toHaveText([dontRun('loner'), ISOLATED, OFF]);
});

test('#817 a file with more than 50 hooks lists 50, and says how many more are in it', async ({ page }) => {
  const hooks = await openHooks(page, 'many');
  const rows = hooks.locator('li');
  await expect.soft(rows).toHaveCount(51);
  await expect.soft(rows.first()).toHaveText('Bash hook 0 from the project’s shared settings');
  await expect.soft(rows.nth(49)).toHaveText('Bash hook 49 from the project’s shared settings');
  await expect.soft(rows.last()).toHaveText(`and 5 more in ${manyFile}`);
});
