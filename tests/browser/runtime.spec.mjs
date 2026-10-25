// What the persona sheet says an agent runs with: your MCP servers, each with its status and a checkbox that’s on by
// default (#59), and that saving stores the ones turned off; the Tools checklist’s real-backend id and what ticking
// means there (#5); and the effort field next to the model, which saving stores (#60).
// With a stand-in Claude Code backend so the real backend’s fields show, and the person’s Claude Code config from the
// spec’s own home, so it never reads the real one. Each test has a persona of its own. Moved from
// tools/check-runtime.mjs (#303).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let folder;
test.beforeAll(async () => {
  app = await startPostbox('runtime', {
    // One user-scope server in the home folder, and an approved project server in the agent’s folder. The secret
    // stands for what a real config can hold: it must never reach the page.
    async prepare(root) {
      folder = join(root, 'work');
      await mkdir(join(folder, '.claude'), { recursive: true });
      await writeFile(join(root, '.claude.json'), JSON.stringify({ mcpServers: { search: { command: 'search-server', env: { TOKEN: 'secret-token-123' } } } }));
      await writeFile(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }));
      await writeFile(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    },
  });
  // A stand-in for the Claude Code backend: it never runs a turn here, it only makes the real fields show.
  app.rt.adapters.register({ name: 'claude-code', deliver: async () => {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/**
 * A persona of its own on Claude Code, in a conversation whose session’s last init reported Postbox’s own server, the
 * user server and a claude.ai connector, or the servers given. Opens the page.
 */
async function persona(page, handle, servers = undefined) {
  const { rt, store } = app;
  const p = rt.createPersona({ handle, backend: 'claude-code', folder });
  const projectId = Object.keys(store.state.projects)[0];
  const t = rt.createThread({ projectId, title: `Check ${handle}`, personaIds: [p.id] });
  const reported = servers ?? [
    { name: 'postbox', status: 'connected', source: 'dynamic' },
    { name: 'search', status: 'needs-auth', source: 'user' },
    { name: 'claude.ai Google Drive', status: 'connected', source: 'claudeai' },
  ];
  rt.updateSession(rt.sessionsIn(t.id)[0].id, { backend: 'claude-code', mcpServers: { at: Date.now(), servers: reported } });
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  return { p, projectId };
}
/** Opens the persona editor on a persona, as Settings › Personas does, and waits for its MCP list. */
async function editor(page, id, servers = 3) {
  await page.evaluate((pid) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', pid)), id);
  await expect.poll(() => page.locator('.dialog [data-server]').count(), { message: 'the MCP list' }).toBeGreaterThanOrEqual(servers);
}
/** The MCP list as the page shows it: each server’s name, status line and checkbox state. */
const servers = (page) =>
  page.locator('.dialog [data-server]').evaluateAll((els) =>
    els.map((el) => ({
      name: /** @type {HTMLElement} */ (el).dataset.server,
      checked: el.getAttribute('aria-checked'),
      role: el.getAttribute('role'),
      tab: /** @type {HTMLElement} */ (el).tabIndex,
      status: el.querySelector('.small')?.textContent?.trim() ?? '',
      visible: el.getBoundingClientRect().width > 0,
    })),
  );
const server = (page, name) => page.locator(`.dialog [data-server="${name}"]`);
/** The effort field: its label, value, options, help, and the label of the field before it. */
const effortField = (page, idp) =>
  page.locator(`#${idp}-e`).evaluate((el, id) => {
    const select = /** @type {HTMLSelectElement} */ (el);
    return {
      label: document.querySelector(`label[for="${id}-e"]`)?.textContent,
      value: select.value,
      options: [...select.options].map((o) => o.textContent),
      help: document.getElementById(select.getAttribute('aria-describedby') ?? '')?.textContent ?? '',
      after: select.closest('.field')?.previousElementSibling?.querySelector('.label')?.textContent ?? null,
      visible: select.getBoundingClientRect().width > 0,
    };
  }, idp);

test('#59 the editor lists your user and project servers and the claude.ai connector, each a checkbox on by default, with its status, and no config', async ({
  page,
}) => {
  const { p } = await persona(page, 'lister');
  await editor(page, p.id);
  const list = await servers(page);
  expect(
    list.map((s) => s.name),
    'your servers, not Postbox’s own',
  ).toEqual(['search', 'docs', 'claude.ai Google Drive']);
  expect(
    list.every((s) => s.visible && s.role === 'checkbox' && s.checked === 'true' && s.tab === 0),
    'each a visible checkbox, on, reachable by Tab',
  ).toBe(true);
  const status = Object.fromEntries(list.map((s) => [s.name, s.status]));
  expect(status).toEqual({
    search: 'Needs sign-in · your settings',
    docs: 'Not started yet · this project',
    'claude.ai Google Drive': 'Connected · claude.ai connector',
  });
  expect(await page.evaluate(() => document.body.textContent), 'no server config reaches the page').not.toMatch(/secret-token|search-server/);
});

test('#60 the editor shows Effort right after Model, at Medium by default, with every level Claude Code takes and help', async ({ page }) => {
  const { p } = await persona(page, 'effortful');
  await editor(page, p.id);
  const effort = await effortField(page, 'pe');
  expect([effort.label, effort.value, effort.after, effort.visible]).toEqual(['Effort', 'medium', 'Model', true]);
  expect(effort.options).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max']);
  expect(effort.help).toMatch(/How much it thinks before it answers/);
});

test('#59 #60 Space turns a server off, and Save stores it and the effort on the persona', async ({ page }) => {
  const { store } = app;
  const { p } = await persona(page, 'saver');
  await editor(page, p.id);
  await page.locator('#pe-e').selectOption('high');
  await server(page, 'claude.ai Google Drive').focus();
  await page.keyboard.press('Space');
  await expect(server(page, 'claude.ai Google Drive'), 'Space turns it off').toHaveAttribute('aria-checked', 'false');
  await page.locator('.dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => store.state.personas[p.id].mcpOff, { message: 'Save stores the server turned off' }).toEqual(['claude.ai Google Drive']);
  expect(store.state.personas[p.id].effort, 'and the effort').toBe('high');
});

test('#59 reopened, a server turned off is still off; Isolated says only Postbox’s server loads, focus kept', async ({ page }) => {
  const { p } = await persona(page, 'reopener');
  app.rt.updatePersona(p.id, { mcpOff: ['claude.ai Google Drive'] });
  await synced(page, app);
  await editor(page, p.id);
  await expect(server(page, 'claude.ai Google Drive')).toHaveAttribute('aria-checked', 'false');
  await page.locator('#pe-setup').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.dialog [data-server]'), 'the list gives way').toHaveCount(0);
  await expect(page.locator('.dialog fieldset', { has: page.locator('legend', { hasText: /^MCP servers$/ }) })).toContainText(
    'isolated, so only Postbox’s own server loads',
  );
  await expect(page.locator('#pe-setup'), 'focus stays on the setup checkbox').toBeFocused();
});

test('#59 #60 #5 the new-agent sheet lists your servers, all on, Effort after Model, and agents.outside unticked with what a tick means', async ({ page }) => {
  const { projectId } = await persona(page, 'creator');
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openNewAgent({ projectId: id })), projectId);
  await expect.poll(() => page.locator('.dialog [data-server]').count(), { message: 'the new-agent MCP list' }).toBeGreaterThanOrEqual(2);
  const list = await servers(page);
  expect(
    list.some((s) => s.name === 'search') && list.some((s) => s.name === 'claude.ai Google Drive') && list.every((s) => s.checked === 'true'),
    JSON.stringify(list),
  ).toBe(true);
  const effort = await effortField(page, 'na');
  expect([effort.value, effort.after]).toEqual(['medium', 'Model']);
  const outside = page.locator('.dialog fieldset .check').filter({ has: page.locator('.mono', { hasText: /^agents\.outside$/ }) });
  await expect(outside, 'off by default').toHaveAttribute('aria-checked', 'false');
  await expect(outside.locator('.small')).toHaveText('Message, schedule or start agents outside Postbox');
  await expect(page.locator('.dialog fieldset .help', { hasText: 'unticked tool' })).toContainText(
    /unticked tool is turned off\. A ticked one still follows its permissions/,
  );
});

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('#59 at 375 px the editor, with a long server name, doesn’t scroll sideways', async ({ page }) => {
    const { p } = await persona(page, 'narrow', [{ name: 'plugin:engineering:google calendar and a much longer name', status: 'failed', source: 'plugin' }]);
    await page.evaluate((pid) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', pid)), p.id);
    await expect(page.locator('.dialog [data-server^="plugin:"]')).toBeVisible();
    // Anything that sticks out past the dialog’s right edge (a field’s own text scrolling inside it is fine).
    const wide = await page.locator('.dialog').evaluate((d) => {
      const right = d.getBoundingClientRect().right;
      return [...d.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right > right + 1)
        .map((el) => `${el.className || el.tagName}: ${el.textContent?.slice(0, 40)}`);
    });
    expect(wide, 'nothing sticks out of the dialog').toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'the page doesn’t scroll sideways').toBe(false);
  });
});
