// What the UAT runner reads off the page for its checks (tools/uat/run-files.mjs, readUi), read off a real page: the
// Agents section’s rows, which agents-section-members (#105) compares with the conversation’s agents. Its reading
// had gone stale, so it found no rows in every run and the check fired each time.

import { expect, test } from '@playwright/test';
import { PANEL_CHECKS } from '../../tools/uat/room-checks-panels.mjs';
import { readUi } from '../../tools/uat/run-files.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('uat-read-ui', { demo: false });
  app.store.emit('project', { id: 'pr_ui', name: 'UI', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('the runner reads each agent’s row in the Agents section, so agents-section-members finds them all', async ({ page }) => {
  const ids = ['reader', 'checker'].map((handle) => app.rt.createPersona({ handle }).id);
  const t = app.rt.createThread({ projectId: 'pr_ui', title: 'Two agents', personaIds: ids });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('.agents-sec .agent-btn')).toHaveCount(2);
  const ui = await readUi(page);
  expect(ui.agentRows.sort()).toEqual(['checker', 'reader']);
  const check = PANEL_CHECKS.find((c) => c.id === 'agents-section-members');
  expect(check?.run({ ui, state: app.rt.store.state, threads: [t.id] })).toEqual([]);
});
