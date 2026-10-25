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

const queued = (page, text) => page.locator('.outbox .queued').filter({ hasText: text });
const turnsFor = (r) => calls.filter((call) => call.sessionId === r.worker.id);
const idle = (r) => expect.poll(() => app.rt.turns.has(r.worker.id) || app.rt.exiting.has(r.worker.id)).toBe(false);

test('three individual queued wakes become one reply when the agent finishes', async ({ page }) => {
  const r = await busyRoom(page);
  for (const [index, sender] of r.senders.entries()) app.rt.agentWake(sender.id, r.worker.handle, `Question ${index + 1}`);
  await synced(page, app);
  await expect(page.locator('.outbox .queued')).toHaveCount(3);
  for (const sender of r.senders) await expect(page.locator('.outbox .queued').filter({ hasText: `@${sender.handle}’s message` })).toHaveCount(1);
  releases.get(r.worker.id)();
  await idle(r);
  await synced(page, app);
  await expect(page.locator('.outbox .queued')).toHaveCount(0);
  await expect(page.getByText('Answered 3 queued messages.', { exact: true })).toBeVisible();
  expect(turnsFor(r)).toHaveLength(2);
  expect(turnsFor(r)[1].message.messages.map((message) => message.text)).toEqual(['Question 1', 'Question 2', 'Question 3']);
});

test('Remove and Send now still act on one queued item at a time', async ({ page }) => {
  const r = await busyRoom(page);
  for (const [index, text] of ['Remove only this', 'Send only this now', 'Leave this queued'].entries())
    app.rt.agentWake(r.senders[index].id, r.worker.handle, text);
  await synced(page, app);
  await queued(page, 'Remove only this').getByRole('button', { name: 'Remove the queued message', exact: true }).click();
  await expect(page.locator('.outbox .queued')).toHaveCount(2);
  await queued(page, 'Send only this now').getByRole('button', { name: 'Send now', exact: true }).click();
  await idle(r);
  await synced(page, app);
  await expect(page.locator('.outbox .queued')).toHaveCount(0);
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
  await expect(page.locator('.outbox .queued')).toHaveCount(3);
  releases.get(r.worker.id)();
  await idle(r);
  await synced(page, app);
  await expect(page.getByText('Answered 2 queued messages.', { exact: true })).toBeVisible();
  expect(turnsFor(r)).toHaveLength(2);
  expect(turnsFor(r)[1].message.messages.map((message) => message.text)).toEqual(['Review the current revision', 'Check the tests too']);
});
