// The room’s form follows the room while it is open (#1735): an agent’s row says its state and its queue as they are
// now, and the Members bar’s queue button counts with the queue and is off, saying why, once nothing waits. The form
// stays up while a person adds members or waits, and in a narrow window it is the one statement of an agent’s state.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { member, memberQueue, roomForm } from './room-form.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const holds = new Set();
const releases = new Map();
let count = 0;
test.beforeAll(async () => {
  app = await startPostbox('room-form-live');
  arrange.withAdapter(app.rt, {
    name: 'claude-code',
    folderFor: async () => app.root,
    // A turn of a held agent waits to be released, so its state and its queue can be read mid-turn.
    async deliver(session, _given, ctx) {
      if (holds.delete(session.id))
        await new Promise((resolve) => {
          releases.set(session.id, resolve);
          ctx.signal.addEventListener('abort', resolve, { once: true });
        });
      if (!ctx.signal.aborted) ctx.text('Done.');
    },
  });
});
test.afterAll(async () => {
  for (const release of releases.values()) release();
  await app?.stop();
});
failOnPageErrors(test);

/** A room of two agents, its form open from the top bar’s gear, with the first agent picked. */
async function openForm(page, handle = `live-${++count}`) {
  const personas = [handle, `other-${count}`].map((h) => app.rt.createPersona({ handle: h, backend: 'claude-code' }));
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Live ${count}`, personaIds: personas.map((p) => p.id) });
  const [worker] = arrange.sessionsIn(app.rt, thread.id);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await page.locator('#conversation-actions').click();
  const queue = await memberQueue(page, handle);
  return { thread, worker, handle, row: member(page, handle), queue };
}
const running = (r) => expect.poll(() => releases.has(r.worker.id)).toBe(true);
const idle = (r) => expect.poll(() => arrange.running(app.rt, r.worker.id) || arrange.exiting(app.rt, r.worker.id)).toBe(false);

test('an agent’s row follows a turn starting and ending while the form is open, and focus stays where it was', async ({ page }) => {
  const r = await openForm(page);
  await expect(r.row).toContainText('· idle');
  const edit = roomForm(page).getByRole('button', { name: `Edit ${r.handle}`, exact: true });
  await edit.focus();
  holds.add(r.worker.id);
  app.rt.sendMessage(r.thread.id, { text: `@${r.handle} start` });
  await running(r);
  await expect(r.row, 'the row says it isn’t idle').not.toContainText('· idle');
  await expect(edit, 'a row that changes moves no focus').toBeFocused();
  releases.get(r.worker.id)();
  await idle(r);
  await expect(r.row).toContainText('· idle');
  await expect(edit).toBeFocused();
});

test('the queue button and the row count with the queue, and a drained queue leaves no way to an empty dialog', async ({ page }) => {
  const r = await openForm(page);
  // Nothing waits: the button is there, off, and says why, and a press opens nothing.
  await expect(r.queue).toHaveAccessibleName(`0 messages queued for ${r.handle}`);
  await expect(r.queue).toHaveAttribute('aria-disabled', 'true');
  await expect(r.queue).toHaveAttribute('aria-description', `No messages are waiting for ${r.handle}.`);
  await r.queue.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-queue-dialog')).toHaveCount(0);
  holds.add(r.worker.id);
  app.rt.sendMessage(r.thread.id, { text: `@${r.handle} start` });
  await running(r);
  for (const n of [1, 2]) app.rt.sendMessage(r.thread.id, { text: `@${r.handle} Queued question ${n}` });
  // Each arrival shows without a pick or a repaint: on the button, and in the row.
  await expect(r.queue).toHaveAccessibleName(`2 messages queued for ${r.handle}`);
  await expect(r.queue).toHaveAttribute('aria-disabled', 'false');
  await expect(r.row).toContainText('· 2 queued');
  app.rt.sendMessage(r.thread.id, { text: `@${r.handle} Queued question 3` });
  await expect(r.queue).toHaveAccessibleName(`3 messages queued for ${r.handle}`);
  await expect(r.row).toContainText('· 3 queued');
  // One removed in its dialog: the count follows, and Escape returns focus to the button.
  await r.queue.click();
  await expect(page.locator('.agent-queue-dialog .agent-queue-row')).toHaveCount(3);
  await page
    .locator('.agent-queue-dialog')
    .getByRole('button', { name: /^Remove queued message 1 of 3/ })
    .click();
  await expect(r.queue).toHaveAccessibleName(`2 messages queued for ${r.handle}`);
  await page.keyboard.press('Escape');
  await expect(page.locator('.agent-queue-dialog')).toHaveCount(0);
  await expect(r.queue).toBeFocused();
  // The turn ends and the queue drains: the button is off again, and the row says no queue.
  releases.get(r.worker.id)();
  await idle(r);
  await expect(r.queue).toHaveAccessibleName(`0 messages queued for ${r.handle}`);
  await expect(r.queue).toHaveAttribute('aria-disabled', 'true');
  await expect(r.row).not.toContainText('queued');
  await r.queue.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-queue-dialog')).toHaveCount(0);
});

test('at 320 px the queue button fits the sheet with the longest handle and ten messages waiting', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const r = await openForm(page, `a${'b'.repeat(22)}${++count % 10}`);
  holds.add(r.worker.id);
  app.rt.sendMessage(r.thread.id, { text: `@${r.handle} start` });
  await running(r);
  for (let n = 1; n <= 10; n++) app.rt.sendMessage(r.thread.id, { text: `@${r.handle} Queued question ${n}` });
  await expect(r.queue).toHaveAccessibleName(`10 messages queued for ${r.handle}`);
  await expect(r.queue).toHaveText('10 messages queued');
  const box = /** @type {{ x: number, width: number }} */ (await r.queue.boundingBox());
  expect(box.x + box.width, 'the button ends inside the window').toBeLessThanOrEqual(320);
  expect(await roomForm(page).evaluate((d) => d.scrollWidth <= d.clientWidth), 'the sheet doesn’t scroll sideways').toBe(true);
  releases.get(r.worker.id)();
  await idle(r);
});
