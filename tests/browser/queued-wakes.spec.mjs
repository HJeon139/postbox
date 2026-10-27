// Queued messages retain individual controls but start one combined turn when their agent is free (#374).
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
const calls = [];
const holds = new Set();
const releases = new Map();
let count = 0;
test.beforeAll(async () => {
  app = await startPostbox('queued-wakes');
  app.rt.adapters.register({
    name: 'claude-code',
    folderFor: async () => app.root,
    async deliver(session, message, ctx) {
      calls.push({ sessionId: session.id, message });
      if (holds.delete(session.id)) {
        await new Promise((resolve) => {
          releases.set(session.id, resolve);
          ctx.signal.addEventListener('abort', resolve, { once: true });
        });
        if (!ctx.signal.aborted) ctx.text('Initial work done.');
      } else ctx.text(`Answered ${message.messages?.length ?? 1} queued messages.`);
    },
  });
});
test.afterAll(async () => {
  for (const release of releases.values()) release();
  await app?.stop();
});
failOnPageErrors(test);

function room() {
  const n = ++count;
  const personas = ['worker', 'sender-a', 'sender-b', 'sender-c'].map((name) => app.rt.createPersona({ handle: `${name}-${n}`, backend: 'claude-code' }));
  const thread = app.rt.createThread({
    projectId: Object.keys(app.store.state.projects)[0],
    title: `Queued wakes ${n}`,
    personaIds: personas.map((p) => p.id),
  });
  const [worker, ...senders] = app.rt.sessionsIn(thread.id);
  holds.add(worker.id);
  return { thread, worker, senders };
}

async function busyRoom(page) {
  const r = room();
  await page.goto(`${app.origin}/#/t/${r.thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} start the initial work` });
  await expect.poll(() => releases.has(r.worker.id)).toBe(true);
  return r;
}

const queued = (page, text) => page.locator('.agent-queue-row').filter({ has: page.getByText(text, { exact: true }) });
const mail = (page, r) =>
  page
    .locator('.agent-row')
    .filter({ hasText: `@${r.worker.handle}` })
    .getByRole('button', { name: /queued for/ });
const openQueue = async (page, r) => {
  await mail(page, r).click();
  const dialog = page.locator('.dialog').filter({ hasText: `queued for @${r.worker.handle}` });
  await expect(dialog).toBeVisible();
  return dialog;
};
const turnsFor = (r) => calls.filter((call) => call.sessionId === r.worker.id);
const idle = (r) => expect.poll(() => app.rt.turns.has(r.worker.id) || app.rt.exiting.has(r.worker.id)).toBe(false);

test('three individual queued wakes become one reply when the agent finishes', async ({ page }) => {
  const r = await busyRoom(page);
  for (const [index, sender] of r.senders.entries()) app.rt.agentWake(sender.id, r.worker.handle, `Question ${index + 1}`);
  await synced(page, app);
  await expect(mail(page, r)).toHaveAccessibleName(`3 messages queued for @${r.worker.handle}`);
  await expect(page.locator('.composer .queued')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-row')).toHaveCount(3);
  for (const sender of r.senders) await expect(dialog.locator('.agent-queue-row').filter({ hasText: `From @${sender.handle}` })).toHaveCount(1);
  releases.get(r.worker.id)();
  await idle(r);
  await synced(page, app);
  await expect(mail(page, r)).toBeHidden();
  await expect(page.getByText('Answered 3 queued messages.', { exact: true })).toBeVisible();
  expect(turnsFor(r)).toHaveLength(2);
  expect(turnsFor(r)[1].message.messages.map((message) => message.text)).toEqual(['Question 1', 'Question 2', 'Question 3']);
});

test('Remove and Send now still act on one queued item at a time', async ({ page }) => {
  const r = await busyRoom(page);
  for (const [index, text] of ['Remove only this', 'Send only this now', 'Leave this queued'].entries())
    app.rt.agentWake(r.senders[index].id, r.worker.handle, text);
  await synced(page, app);
  await openQueue(page, r);
  await queued(page, 'Remove only this').getByRole('button', { name: 'Remove the queued message', exact: true }).click();
  await expect(mail(page, r)).toHaveAccessibleName(`2 messages queued for @${r.worker.handle}`);
  await queued(page, 'Send only this now').getByRole('button', { name: 'Send now', exact: true }).click();
  await idle(r);
  await synced(page, app);
  await expect(mail(page, r)).toBeHidden();
  expect(
    turnsFor(r)
      .slice(1)
      .map((call) => call.message.text),
  ).toEqual(['Send only this now', 'Leave this queued']);
});

test('a newer request replaces an older queued wake when the batch starts', async ({ page }) => {
  const r = await busyRoom(page);
  app.rt.agentWake(r.senders[0].id, r.worker.handle, 'Review the old revision');
  app.rt.agentWake(r.senders[0].id, r.worker.handle, 'Review the current revision');
  app.rt.agentWake(r.senders[1].id, r.worker.handle, 'Check the tests too');
  await synced(page, app);
  await expect(mail(page, r)).toHaveAccessibleName(`3 messages queued for @${r.worker.handle}`);
  releases.get(r.worker.id)();
  await idle(r);
  await synced(page, app);
  await expect(page.getByText('Answered 2 queued messages.', { exact: true })).toBeVisible();
  expect(turnsFor(r)).toHaveLength(2);
  expect(turnsFor(r)[1].message.messages.map((message) => message.text)).toEqual(['Review the current revision', 'Check the tests too']);
});

test('an unaddressed newer post reaches the waiting target exactly once', async ({ page }) => {
  const r = await busyRoom(page);
  const sender = r.senders[0];
  app.rt.agentWake(sender.id, r.worker.handle, 'Review the older context');
  const newer = app.rt.addItem(r.thread.id, {
    kind: 'agent',
    sessionId: sender.id,
    handle: sender.handle,
    text: 'New context without a mention',
    status: 'done',
  });
  await synced(page, app);
  await expect(mail(page, r)).toHaveAccessibleName(`1 message queued for @${r.worker.handle}`);
  releases.get(r.worker.id)();
  await idle(r);
  await synced(page, app);
  await expect(mail(page, r)).toBeHidden();
  await expect(page.getByText('Answered 1 queued messages.', { exact: true })).toBeVisible();
  expect(turnsFor(r)).toHaveLength(2);
  expect(turnsFor(r)[1].message.text).toBe(newer.text);
  expect(turnsFor(r)[1].message.itemId).toBe(newer.id);
});

test('#427 ten queued messages stay out of the composer and edit in the agent’s bounded mail view', async ({ page }) => {
  const r = await busyRoom(page);
  for (let index = 0; index < 10; index++) app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} Queued question ${index + 1}` });
  await synced(page, app);
  await expect(mail(page, r)).toHaveAccessibleName(`10 messages queued for @${r.worker.handle}`);
  await expect(page.locator('.composer .queued')).toHaveCount(0);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const composer = await page.locator('.composer').boundingBox();
    expect(composer.height, `${width} px composer height`).toBeLessThan(150);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-row')).toHaveCount(10);
  const list = await dialog.locator('.agent-queue-list').boundingBox();
  expect(list.height).toBeLessThanOrEqual(480);
  const row = queued(page, `@${r.worker.handle} Queued question 1`);
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = row.getByRole('textbox', { name: 'Edit the queued message' });
  await expect(editor).toBeFocused();
  await editor.fill('A longer revised question\nwith its second line.');
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(queued(page, 'A longer revised question\nwith its second line.')).toBeVisible();
  await expect(mail(page, r)).toHaveAccessibleName(`10 messages queued for @${r.worker.handle}`);
});

test('#427 offline rows replace their prior paint and disappear after reconnecting', async ({ page }) => {
  await page.goto(app.origin);
  const counts = await page.evaluate(async () => {
    const { paintOfflineQueue } = await import('/app/js/agent-queue.mjs');
    const box = document.createElement('div');
    const message = { threadId: 't1', text: 'Saved while offline', attachments: [] };
    paintOfflineQueue(box, [message]);
    const first = box.children.length;
    paintOfflineQueue(box, [message]);
    const second = box.children.length;
    paintOfflineQueue(box, []);
    return [first, second, box.children.length];
  });
  expect(counts).toEqual([1, 1, 0]);
});
