// Antigravity’s bar on the composer’s quota line (#1466, designs/architecture/adapters.md, “Quota: each backend’s usage,
// in the composer”): from agy’s /usage, its most-used pool named after the window. Moved from quota-line.spec.mjs,
// which was at its size. Figures are made up.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const resetsAt = Date.now() + 3 * 3_600_000;
test.beforeAll(async () => {
  app = await startPostbox('quota-line-agy');
  arrange.withAdapter(app.rt, { name: 'antigravity-cli', folderFor: async () => app.root, async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
const line = (page) => page.locator('.composer .quota-line');
const bar = (page, backend) => line(page).getByRole('meter', { name: new RegExp(`^${backend} quota`) });

test('#1466 Antigravity gets a bar from its /usage, its most-used pool named after the window', async ({ page }) => {
  const n = ++count;
  const persona = app.rt.createPersona({ handle: `agy${n}`, backend: 'antigravity-cli' });
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Agy ${n}`, personaIds: [persona.id] });
  // What agyQuota makes of a /usage answer where Claude and GPT models’ pool is the most used (made-up figures).
  app.store.emit('quota', {
    id: 'antigravity-cli',
    backend: 'antigravity-cli',
    host: null,
    status: 'ok',
    windows: [
      { name: '5 h', used: 0.03, resetsAt, seenAt: Date.now() },
      { name: '7 d', used: 0.4, resetsAt, limit: 'Claude and GPT models', limitName: 'Claude and GPT models', seenAt: Date.now() },
    ],
    seenAt: Date.now(),
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(bar(page, 'Antigravity CLI')).toHaveAttribute('aria-valuenow', '40');
  await expect(bar(page, 'Antigravity CLI')).toHaveAttribute('aria-valuetext', /^Antigravity CLI 40% of 7 d \(Claude and GPT models\) · resets /);
});
