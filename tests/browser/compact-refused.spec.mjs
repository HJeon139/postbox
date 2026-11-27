// #1811, #1812: /compact sent to a Kiro CLI or an Antigravity agent is refused before anything is posted, and the page
// says why (server/adapters/no-compaction.mjs). Each runs its real adapter, whose spawn fails the test: the refusal
// starts no process, and nothing reaches the model.

import { expect, test } from '@playwright/test';
import { AntigravityCliAdapter } from '../../server/adapters/antigravity-cli.mjs';
import { KiroCliAdapter } from '../../server/adapters/kiro-cli.mjs';
import * as arrange from '../arrange.mjs';
import { tempDir } from '../temp-dirs.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const spawnImpl = () => {
  throw new Error('This spec starts no process.');
};
test.beforeAll(async () => {
  app = await startPostbox('compact-refused');
  const bin = '/nonexistent/postbox-test-cli';
  arrange.withAdapter(app.rt, new KiroCliAdapter({ bin, workRoot: app.root, isolatedHome: tempDir('pb-kiro-home-'), spawnImpl }));
  arrange.withAdapter(app.rt, new AntigravityCliAdapter({ bin, workRoot: app.root, spawnImpl }));
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

for (const [backend, handle, harness] of [
  ['kiro-cli', 'kiro', 'Kiro CLI'],
  ['antigravity-cli', 'agy', 'Antigravity'],
])
  test(`#1811 #1812 /compact for ${backend === 'antigravity-cli' ? 'an' : 'a'} ${backend} agent says why it can’t, and posts nothing`, async ({ page }) => {
    const { rt } = app;
    const projectId = Object.values(rt.store.state.projects)[0].id;
    const p = rt.createPersona({ handle, backend });
    const t = rt.createThread({ projectId, title: `Compact ${handle}`, personaIds: [p.id] });
    const before = rt.store.items(t.id).length;
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    // The server’s 422 is the refusal itself, which the page shows as a notice.
    allowPageError(page, /status of 422/);
    const input = page.locator('.composer textarea').first();
    await input.fill('/compact');
    await input.press('Enter');
    const notice = page.getByText(`@${handle} can’t compact its conversation: ${harness} has no compaction Postbox can run.`);
    await expect(notice).toBeVisible();
    await synced(page, app);
    expect(rt.store.items(t.id).length, 'nothing posted').toBe(before);
    expect(rt.turns.size, 'no turn').toBe(0);
  });
