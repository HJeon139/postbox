// Each row of an agent’s queue says what is waiting (#1456): your answer to a card names the card, and your message
// says its words even when the page hasn’t loaded it. With a scripted Claude Code agent held busy until the test ends.
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const holds = new Set();
const releases = new Map();
let count = 0;

test.beforeAll(async () => {
  app = await startPostbox('queue-row-text');
  arrange.withAdapter(app.rt, {
    name: 'claude-code',
    folderFor: async () => app.root,
    async deliver(session, _given, ctx) {
      if (holds.delete(session.id))
        await new Promise((resolve) => {
          releases.set(session.id, resolve);
          ctx.signal.addEventListener('abort', resolve, { once: true });
        });
      ctx.text('Done.');
    },
  });
});
test.afterAll(async () => {
  for (const release of releases.values()) release();
  await app?.stop();
});
failOnPageErrors(test);

/** A conversation with one agent busy in a turn held open, and the page on it. */
async function busyRoom(page) {
  const n = ++count;
  const persona = app.rt.createPersona({ handle: `writer-${n}`, backend: 'claude-code' });
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Queue rows ${n}`, personaIds: [persona.id] });
  const [worker] = arrange.sessionsIn(app.rt, thread.id);
  holds.add(worker.id);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: `@${worker.handle} start the long work` });
  await expect.poll(() => releases.has(worker.id)).toBe(true);
  return { thread, worker };
}

/** The worker’s queue, opened from its row in the agents list. */
async function openQueue(page, r) {
  await page
    .locator('.agent-row')
    .filter({ hasText: r.worker.handle })
    .getByRole('button', { name: /queued for/ })
    .click();
  return page.getByRole('dialog', { name: new RegExp(`queued for ${r.worker.handle}`) });
}

test('your answer to a card waits in the queue named for the card', async ({ page }) => {
  const r = await busyRoom(page);
  const confirm = {
    id: 'frames',
    type: 'confirm',
    version: 1,
    fallback: 'Delete the frames?',
    title: 'Delete the video frames?',
    statement: 'Delete the **23** untracked frames?',
    confirmLabel: 'Delete',
  };
  const said = await app.rt.toolsFor(r.worker.id).show_block({ block: confirm });
  expect(said.ok, said.message).toBe(true);
  const card = app.store.items(r.thread.id).find((x) => x.kind === 'block' && x.block.id === 'frames');
  app.rt.act(r.thread.id, card.id, 'confirm', {});
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText('Your answer to “Delete the video frames?”');
});

test('your message the page hasn’t loaded still shows its words in the queue', async ({ page }) => {
  const r = await busyRoom(page);
  // Enough lines before and after the message that the page, opened again, loads neither the first nor the latest
  // items with it (#1155).
  const lines = (from) => {
    for (let i = from; i < from + 250; i++) arrange.post(app.rt, r.thread.id, { kind: 'user', text: `Line ${i}`, attachments: [], to: [] });
  };
  lines(0);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} then check the second table` });
  lines(250);
  await page.reload();
  await synced(page, app);
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} then check the second table`);
});
