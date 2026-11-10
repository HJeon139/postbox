// The permissions panel names the PreToolUse and PermissionRequest hooks in the settings files an agent reads (#817,
// #871): Postbox’s own settings turn them off in Ask me and Accept edits, and keep them in Auto and Run everything
// (#806), so the panel says where they run, and that hooks the person’s organization manages always do. Each row says its event. A hook’s command is the person’s
// data, shown as text. Scripted Claude Code agents, one per state, working in temp folders, with a home of their own
// for the user settings.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, PHONE, settled, startPostbox, synced, windowWidth } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Each state’s conversation, by its agent’s handle. @type {Record<string, string>} */
const threads = {};
let manyFile = '';
/** @type {(name: string) => string} */
let brokenFile = (name) => name;

const MARKUP = 'echo "<b id=hook-markup>allow</b>" && exit 0';
const USER_ROW = 'PreToolUse Bash ~/bin/audit-bash from your user settings';
const PROJECT_ROW = `PreToolUse Bash ${MARKUP} from the project’s shared settings`;
// A PermissionRequest hook that approves, with a long command and a token in its matcher and command (#871).
const RULES = Array(12).fill('--rule allow').join(' ');
const APPROVE = `node ~/bin/approve.js --token sk-871 ${RULES}`;
const ASKS_ROWS = [
  'PreToolUse Edit check-edit from the project’s shared settings',
  `PermissionRequest Bash|api_key=… node ~/bin/approve.js --token … ${RULES} from the project’s shared settings`,
];
const OFF =
  'In Ask me and Accept edits, Postbox turns off hooks from settings files, plugin hooks and your custom status line for its own turns, since a hook that approves a tool call would skip the ask rules and the permission card. In Auto and Run everything they run, as when you use Claude Code yourself. Postbox can’t list your plugins’ hooks here: /hooks in Claude Code shows them. Hooks your organization manages always run, and one of those can approve a call without asking you.';
const runs = (handle, mode) =>
  `In ${mode} mode, these run in ${handle}’s Postbox turns too. One that allows a call also skips your ask rules, this conversation’s included, as in your terminal.`;
const ISOLATED = 'It’s isolated, so it doesn’t read the hooks in your user settings.';
const dontRun = (handle, mode) =>
  `These don’t run in ${handle}’s Postbox turns in ${mode} mode. They run in Auto and Run everything, and when you use Claude Code yourself.`;

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
      folders.broken = join(root, 'broken');
      folders.asker = join(root, 'asks');
      for (const dir of [join(root, '.claude'), ...['work', 'many', 'broken', 'asker'].map((k) => join(folders[k], '.claude'))])
        await mkdir(dir, { recursive: true });
      // The PermissionRequest hook comes first in the file, and the panel still lists the PreToolUse one first.
      const asks = {
        PermissionRequest: [{ matcher: 'Bash|api_key=sk-9', hooks: [{ type: 'command', command: APPROVE }] }],
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'check-edit' }] }],
      };
      await writeFile(join(folders.asker, '.claude', 'settings.json'), JSON.stringify({ hooks: asks }));
      // Neither file an Isolated agent reads there is JSON.
      for (const name of ['settings.json', 'settings.local.json']) await writeFile(join(folders.broken, '.claude', name), '{');
      brokenFile = (name) => join(folders.broken, '.claude', name);
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
    ['loner', { permissionMode: 'ask', usesHostSetup: false }],
    ['many', { permissionMode: 'auto', usesHostSetup: false }],
    ['broken', { permissionMode: 'auto', usesHostSetup: false }],
    ['asker', { permissionMode: 'acceptEdits', usesHostSetup: false }],
  ]) {
    const persona = rt.createPersona({ handle, backend: 'claude-code', ...setup });
    threads[handle] = rt.createThread({ projectId: 'pr_hooks', title: handle, personaIds: [persona.id] }).id;
  }
  // An agent on a host (#120): the panel reads this computer’s files, not the host’s.
  const host = rt.addHost({ name: 'build.example.com' });
  const remote = rt.createPersona({ handle: 'remote', backend: 'claude-code', permissionMode: 'auto' });
  store.emit('persona', { ...store.state.personas[remote.id], remote: { hostId: host.id } });
  threads.remote = rt.createThread({ projectId: 'pr_hooks', title: 'remote', personaIds: [remote.id] }).id;
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

test('#806 the panel names each PreToolUse hook as text, and in Auto mode says it runs in Postbox turns', async ({ page }) => {
  const hooks = await openHooks(page, 'coder');
  await expect.soft(hooks.locator('li')).toHaveText([USER_ROW, PROJECT_ROW]);
  await expect.soft(hooks.locator('p.help')).toHaveText([runs('coder', 'Auto'), OFF]);
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
  await expect.soft(hooks.locator('p.help')).toHaveText([runs('runner', 'Run everything'), OFF]);
});

test('#817 an Isolated agent’s panel lists the project’s hooks only, and in Ask me mode says they don’t run', async ({ page }) => {
  const hooks = await openHooks(page, 'loner');
  await expect.soft(hooks.locator('li')).toHaveText([PROJECT_ROW]);
  await expect.soft(hooks.locator('p.help')).toHaveText([dontRun('loner', 'Ask me'), ISOLATED, OFF]);
});

test('#817 a file with more than 50 hooks lists 50, and says how many more are in it', async ({ page }) => {
  const hooks = await openHooks(page, 'many');
  const rows = hooks.locator('li');
  await expect.soft(rows).toHaveCount(51);
  await expect.soft(rows.first()).toHaveText('PreToolUse Bash hook 0 from the project’s shared settings');
  await expect.soft(rows.nth(49)).toHaveText('PreToolUse Bash hook 49 from the project’s shared settings');
  await expect.soft(rows.last()).toHaveText(`and 5 more in ${manyFile}`);
});

test('#817 for an agent on a host, the panel says the hooks listed are this computer’s, not that they won’t run', async ({ page }) => {
  const hooks = await openHooks(page, 'remote');
  await expect.soft(hooks.locator('li')).toHaveText([USER_ROW, PROJECT_ROW]);
  await expect
    .soft(hooks.locator('p.help'))
    .toHaveText(['remote runs on build.example.com. These are the hooks in this computer’s settings files; the host’s own settings aren’t shown here.', OFF]);
});

test('#817 when no settings file can be listed, the panel says why for each, and not that there are no hooks', async ({ page }) => {
  const hooks = await openHooks(page, 'broken');
  await expect
    .soft(hooks.locator('p.err'))
    .toHaveText([
      `${brokenFile('settings.json')} isn’t valid JSON, so Postbox can’t list its hooks.`,
      `${brokenFile('settings.local.json')} isn’t valid JSON, so Postbox can’t list its hooks.`,
    ]);
  await expect.soft(hooks.locator('li')).toHaveCount(0);
  await expect.soft(hooks.getByText('No PreToolUse or PermissionRequest hooks'), 'no “none” beside the errors').toHaveCount(0);
  await expect.soft(hooks.locator('p.help')).toHaveText([ISOLATED, OFF]);
});

// #871: a PermissionRequest hook can approve a call too, so it gets a row of its own, with its event, at both widths.
for (const [width, phone] of [
  [375, true],
  [1280, false],
]) {
  test.describe(`at ${width} px`, () => {
    test.use(phone ? { viewport: { width, height: 800 }, ...PHONE } : { viewport: { width, height: 900 } });

    test(`#871 the panel names each PermissionRequest hook, with its event, and fits the window (${width} px)`, async ({ page }) => {
      const hooks = await openHooks(page, 'asker');
      await expect.soft(hooks.locator('li')).toHaveText(ASKS_ROWS);
      await expect.soft(hooks.locator('li').nth(1).getByText('PermissionRequest', { exact: true }), 'the event is named').toBeVisible();
      await expect.soft(hooks.locator('p.help')).toHaveText([dontRun('asker', 'Accept edits'), ISOLATED, OFF]);
      await expect.soft(hooks.getByText('sk-871'), 'the token in the command stays hidden').toHaveCount(0);
      await settled(page);
      const over = await page
        .locator('.dialog')
        .evaluate((d, w) => [d.scrollWidth - d.clientWidth, document.documentElement.scrollWidth - w], windowWidth(page));
      expect.soft(over, 'nothing overflows sideways').toEqual([0, 0]);
    });
  });
}
