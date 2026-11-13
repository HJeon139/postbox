// The permissions panel for an agent on a remote host (#120): the rules it lists are this computer's settings files,
// and the agent's Claude Code reads the host's, so the panel says so. A scripted Claude Code agent, placed on a host
// that's added but never installed: nothing connects to it.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
let host;
let other;
let persona;

test.beforeAll(async () => {
  let work = '';
  app = await startPostbox('permissions-host', {
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(work, { recursive: true });
    },
  });
  const { rt, store } = app;
  arrange.withAdapter(rt, {
    name: 'claude-code',
    async folderFor() {
      return work;
    },
    async deliver(_session, _message, ctx) {
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_host', name: 'Host', folder: work });
  host = rt.addHost({ name: 'build.example.com' });
  other = rt.addHost({ name: 'other.example.com' });
  persona = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'ask' });
  store.emit('persona', { ...store.state.personas[persona.id], remote: { hostId: host.id } });
  thread = rt.createThread({ projectId: 'pr_host', title: 'On a host', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#120 the panel for an agent on a host says its Claude Code reads the host’s settings, not the ones listed here', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await page.locator('header.topbar button[aria-label^="Actions for"]').click();
  await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.perm-panel')).toBeVisible();
  await expect(dialog).toContainText('coder runs on build.example.com, where Claude Code reads the agent folder’s settings files there');
  await expect(dialog).toContainText('not the ones listed here from this computer');
});

/** The coder’s permissions panel, opened from the conversation’s menu. */
async function openPanel(page) {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await page.locator('header.topbar button[aria-label^="Actions for"]').click();
  await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.perm-panel')).toBeVisible();
  return dialog;
}

test('#120 the panel lists rules Postbox keeps for each host, removes one, and only this host’s decide a call', async ({ page }) => {
  const { rt, store } = app;
  store.emit('persona', {
    ...store.state.personas[persona.id],
    tools: ['shell'],
    hostRules: [
      { hostId: host.id, rule: 'Bash(make test)' },
      { hostId: other.id, rule: 'Bash(npm test)' },
    ],
  });
  const dialog = await openPanel(page);
  const row = (rule) => dialog.locator('.list-rows li', { hasText: rule });
  await expect(row('Bash(make test)')).toContainText('from Postbox, for build.example.com');
  await expect(row('Bash(npm test)')).toContainText('from Postbox, for other.example.com');
  // The checker counts only the rules for the host the agent runs on now.
  const call = dialog.locator('#perm-call');
  const verdict = dialog.locator('.perm-verdict');
  await call.fill('Bash(make test)');
  await expect(verdict).toHaveText('Runs: the allow rule Bash(make test) from Postbox, for its host.');
  await call.fill('Bash(npm test)');
  await expect(verdict).toContainText('No rule covers it');
  // Remove takes out that host’s rule only.
  await row('Bash(npm test)').getByRole('button', { name: 'Remove the allow rule Bash(npm test) from Postbox, for other.example.com' }).click();
  await expect(row('Bash(npm test)')).toHaveCount(0);
  await expect(row('Bash(make test)')).toHaveCount(1);
  expect(rt.persona(persona.id).hostRules).toEqual([{ hostId: host.id, rule: 'Bash(make test)' }]);
});

test('#120 a host card’s Always allow says Postbox keeps the rule for that host', async ({ page }) => {
  const { rt } = app;
  const se = arrange.agentIn(rt, thread.id);
  const input = { command: 'make lint' };
  arrange.post(rt, thread.id, {
    kind: 'permission',
    sessionId: se.id,
    handle: 'coder',
    tool: 'Bash',
    summary: 'run make lint',
    detail: 'make lint',
    input,
    always: arrange.alwaysFor(rt, se, { tool: 'Bash', input, suggestions: null, suppressAlways: false, hostId: host.id }),
    remote: { hostId: host.id, turn: 'ht_card', prompt: 'p_card' },
    status: 'open',
  });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect(page.locator('.perm-always')).toHaveText(
    'Always allow Bash(make lint:*) on build.example.com (Postbox keeps it, and sends it with each turn there)',
  );
});
