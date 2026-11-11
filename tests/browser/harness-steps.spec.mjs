// A running turn’s steps, as the harness-event contract reports them (server/harness-events.mjs): open while the turn
// runs, as the harness shows them, each with its call’s input and the end of what it returned. A recorded Claude Code
// turn (tests/fixtures/claude-code/ledger-edits.jsonl) replays through the real stream mapper and the contract, held
// after a call that failed, so the steps are seen while the turn still runs.

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createStreamMapper } from '../../server/adapters/claude-stream.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
const lines = readFileSync(new URL('../fixtures/claude-code/ledger-edits.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
// Held once the `ls` of a missing path has failed: reads, an edit and writes before it, a background command after.
const PAUSE = lines.findIndex((e) => e.type === 'user' && JSON.stringify(e.message?.content ?? '').includes('nope-missing')) + 1;
let go = () => {};
let held = false;

test.beforeAll(async () => {
  app = await startPostbox('harness-steps');
  const { rt, store } = app;
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(_session, _message, ctx) {
      const m = createStreamMapper(ctx);
      for (const e of lines.slice(0, PAUSE)) m.push(e);
      held = true;
      await new Promise((r) => {
        go = () => r(undefined);
      });
      for (const e of lines.slice(PAUSE)) m.push(e);
    },
  });
  const project = Object.values(store.state.projects)[0];
  const p = rt.createPersona({ handle: 'recorder', backend: 'claude-code', model: 'claude-haiku-5-5' });
  thread = rt.createThread({ projectId: project.id, title: 'Steps as they run', personaIds: [p.id] });
});
test.afterAll(async () => {
  go();
  await app?.stop();
});
failOnPageErrors(test);

test('a running turn’s steps are open, each with what it was given and what it returned', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: 'Make the ledger edits.' });
  await expect.poll(() => held, { message: 'the turn to reach its pause' }).toBe(true);
  const list = page.locator('details.activity').last();
  await expect(list, 'open while the turn runs').toHaveAttribute('open', '');
  const step = (/** @type {string} */ label) => list.locator('.steps > li').filter({ has: page.locator('.mono', { hasText: label }) });
  await test.step('a read shows its file and the end of what it read', async () => {
    const read = step('Read notes.txt');
    await expect(read.locator('.step-input')).toHaveText('file_path: /workspace/rec/notes.txt');
    await expect(read.locator('.step-output')).toContainText('3\tgamma');
  });
  await test.step('a command that failed shows its command, why, and its output', async () => {
    const failed = step('List a missing path (expected to fail)');
    await expect(failed.locator('[aria-label="failed"]')).toBeVisible();
    await expect(failed.locator('.step-input')).toContainText('command: ls nope-missing');
    await expect(failed.locator('.step-output')).toContainText('No such file or directory');
    await expect(failed.locator('.step-note'), 'why it failed shows once, in its output').toHaveCount(0);
  });
  go();
  await expect.poll(() => app.rt.turns.size, { message: 'the turn to end' }).toBe(0);
});
