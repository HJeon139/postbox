// #425: a compaction’s line in the room. A harness that counts what it kept (Claude Code) shows its counts; one that
// doesn’t (Codex, tests/fixtures/codex-app-server/compact.jsonl) shows none, rather than “NaN”, and its summary still
// opens.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('compaction-line', { demo: false });
  app.store.emit('project', { id: 'pr_c', name: 'C', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#425 a compaction with counts shows them, and one without shows none, with no NaN', async ({ page }) => {
  const ids = ['claude', 'gpt'].map((handle) => app.rt.createPersona({ handle }).id);
  const t = app.rt.createThread({ projectId: 'pr_c', title: 'Compactions', personaIds: ids });
  arrange.post(app.rt, t.id, { kind: 'system', variant: 'compaction', handle: 'claude', n: 1, kept: 41000, total: 182000, summary: 'Kept the plan.' });
  arrange.post(app.rt, t.id, {
    kind: 'system',
    variant: 'compaction',
    handle: 'gpt',
    n: 1,
    summary: 'Codex summarized the earlier conversation to make room.',
  });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const pills = page.locator('.sys .pill', { hasText: 'Context compacted' });
  await expect(pills).toHaveCount(2);
  await expect(pills.nth(0)).toContainText('claude #1 · kept 41k of 182k tokens');
  await expect(pills.nth(1)).toContainText('gpt #1');
  await expect(pills.nth(1)).not.toContainText('kept');
  await expect(pills.nth(1)).not.toContainText('NaN');
  await pills.nth(1).getByRole('button', { name: 'Show summary' }).click();
  await expect(page.getByText('Codex summarized the earlier conversation to make room.')).toBeVisible();
});
