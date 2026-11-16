// The person’s message to a busy agent is posted when it’s sent (#1404): it shows in the conversation at once, and
// waits in the agent’s queue as an entry. The queue’s Edit changes the message where it was said, and Remove marks it
// there as removed before any agent read it. With a scripted Claude Code agent held busy until the test releases it.
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What each turn was given, as its messages’ texts. */
const calls = [];
const holds = new Set();
const releases = new Map();
let count = 0;

test.beforeAll(async () => {
  app = await startPostbox('person-queue');
  arrange.withAdapter(app.rt, {
    name: 'claude-code',
    folderFor: async () => app.root,
    async deliver(session, message, ctx) {
      calls.push({ sessionId: session.id, texts: (message.messages ?? [message]).map((m) => m.text) });
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
  const persona = app.rt.createPersona({ handle: `worker-${n}`, backend: 'claude-code' });
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Person queue ${n}`, personaIds: [persona.id] });
  const [worker] = arrange.sessionsIn(app.rt, thread.id);
  holds.add(worker.id);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: `@${worker.handle} start the long work` });
  await expect.poll(() => releases.has(worker.id)).toBe(true);
  return { thread, worker };
}

/** Sends a message from the composer, as the person types it. */
async function send(page, text) {
  await page.locator('#composer-input').fill(text);
  await page.locator('#composer-input').press('Enter');
}
const mine = (page, text) => page.locator('.transcript .turn.me').filter({ hasText: text });
const mail = (page, r) =>
  page
    .locator('.agent-row')
    .filter({ hasText: r.worker.handle })
    .getByRole('button', { name: /queued for/ });
const givenTo = (r, text) => calls.filter((c) => c.sessionId === r.worker.id && c.texts.includes(text)).length;

test('#1404 your message to a busy agent shows in the conversation when it’s sent, and its queue counts it', async ({ page }) => {
  const r = await busyRoom(page);
  const text = `@${r.worker.handle} and then the summary`;
  await send(page, text);
  await expect(mine(page, 'and then the summary'), 'in the conversation at once').toBeVisible();
  await expect(mail(page, r)).toHaveAccessibleName(`1 message queued for ${r.worker.handle}`);
  releases.get(r.worker.id)();
  await expect.poll(() => givenTo(r, text), { message: 'its turn is given it' }).toBe(1);
  await expect(mail(page, r)).toBeHidden();
  await expect(mine(page, 'and then the summary')).toHaveCount(1);
});

test('#1404 Edit in the queue changes the message where it was said, and the agent reads it as edited', async ({ page }) => {
  const r = await busyRoom(page);
  await send(page, `@${r.worker.handle} check the first table`);
  await mail(page, r).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`queued for ${r.worker.handle}`) });
  await dialog.getByRole('button', { name: /^Edit message 1 of 1/ }).click();
  await dialog.getByRole('textbox', { name: 'Edit the queued message' }).fill(`@${r.worker.handle} check the second table`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(mine(page, 'check the second table'), 'the conversation shows the edit').toBeVisible();
  await expect(mine(page, 'check the first table')).toHaveCount(0);
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} check the second table`);
  await page.keyboard.press('Escape');
  releases.get(r.worker.id)();
  await expect.poll(() => givenTo(r, `@${r.worker.handle} check the second table`)).toBe(1);
});

test('#1404 Remove in the queue leaves the message where it was said, marked removed before any agent read it', async ({ page }) => {
  const r = await busyRoom(page);
  const text = `@${r.worker.handle} never mind this one`;
  await send(page, text);
  await mail(page, r).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`queued for ${r.worker.handle}`) });
  await dialog.getByRole('button', { name: /^Remove queued message 1 of 1/ }).click();
  await expect(mine(page, 'never mind this one')).toContainText('Removed before any agent read it');
  releases.get(r.worker.id)();
  await expect.poll(() => arrange.running(app.rt, r.worker.id)).toBe(false);
  expect(givenTo(r, text), 'no turn was given it').toBe(0);
});
