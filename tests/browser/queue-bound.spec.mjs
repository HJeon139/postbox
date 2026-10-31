// However many messages wait for busy agents, the composer stays a bounded part of the window and the conversation
// keeps the rest (#427; requirement AT-6, as critic worded it in critic-427-470-coverage: the composer’s queue area at
// most 25% of the viewport at 375 and 1280 px). On main every queued message is a full-width row in the sticky
// composer, about 59 px each, so ten of them take 85% of an 800 px window (the UAT table in #427).
import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** The most of the window the composer may take, queue included. */
const BOUND = 0.25;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {Map<string, () => void>} */
const releases = new Map();
let count = 0;
test.beforeAll(async () => {
  app = await startPostbox('queue-bound');
  app.rt.adapters.register({
    name: 'claude-code',
    folderFor: async () => app.root,
    // Every agent's first turn holds until the test ends, so whatever the person sends it next waits in the queue.
    async deliver(session, _message, ctx) {
      if (releases.has(session.id)) return ctx.text('Answered.');
      await new Promise((resolve) => {
        releases.set(session.id, () => resolve(null));
        ctx.signal.addEventListener('abort', resolve, { once: true });
      });
    },
  });
});
test.afterAll(async () => {
  for (const release of releases.values()) release();
  await app?.stop();
});
failOnPageErrors(test);

/** A conversation with `agents` agents, each busy with a turn that doesn't end. */
async function busyRoom(agents) {
  const n = ++count;
  const personas = Array.from({ length: agents }, (_, i) => app.rt.createPersona({ handle: `worker${i + 1}-${n}`, backend: 'claude-code' }));
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Queue bound ${n}`, personaIds: personas.map((p) => p.id) });
  const sessions = app.rt.sessionsIn(thread.id);
  for (const se of sessions) app.rt.sendMessage(thread.id, { text: `@${se.handle} start the long job` });
  await expect.poll(() => sessions.every((se) => releases.has(se.id))).toBe(true);
  for (let i = 1; i <= 12; i++) app.rt.addItem(thread.id, { kind: 'user', text: `Earlier message ${i}, so the conversation is long enough to scroll.` });
  return { thread, sessions };
}

/** The composer's share of the window's height. */
const share = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.composer');
    return (c?.getBoundingClientRect().height ?? 0) / innerHeight;
  });

for (const width of [1280, 375])
  for (const agents of [1, 5])
    for (const queued of [1, 3, 6, 10])
      test(`#427 at ${width} px: ${queued} queued for ${agents === 1 ? 'one agent' : `${agents} agents`} keep the composer within ${BOUND * 100}% of the window`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        const { thread, sessions } = await busyRoom(agents);
        await page.goto(`${app.origin}/#/t/${thread.id}`);
        await synced(page, app);
        for (let i = 0; i < queued; i++)
          app.rt.sendMessage(thread.id, { text: `@${sessions[i % agents].handle} follow-up ${i + 1}: also check the second half of the results` });
        await synced(page, app);
        await settled(page);
        const pending = app.store.state.threads[thread.id].queue?.length ?? 0;
        expect(pending, 'the follow-ups are queued, not delivered').toBe(queued);
        expect(await share(page), 'the composer’s share of the window').toBeLessThanOrEqual(BOUND);
      });

// A short phone (375 × 568, the iPhone SE size): the bound is a share of the height, so it is tightest here.
for (const agents of [1, 5])
  test(`#427 on a 375 × 568 phone: 10 queued for ${agents === 1 ? 'one agent' : `${agents} agents`} keep the composer within ${BOUND * 100}%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 568 });
    const { thread, sessions } = await busyRoom(agents);
    await page.goto(`${app.origin}/#/t/${thread.id}`);
    await synced(page, app);
    for (let i = 0; i < 10; i++) app.rt.sendMessage(thread.id, { text: `@${sessions[i % agents].handle} follow-up ${i + 1}` });
    await synced(page, app);
    await settled(page);
    expect(await share(page), 'the composer’s share of a short phone').toBeLessThanOrEqual(BOUND);
  });

// The side panel has a composer of its own (side-panel.mjs), the second surface #422 and #360 missed.
for (const [width, full] of [
  [1280, false],
  [375, false],
  [1280, true],
])
  test(`#427 in the thread panel at ${width} px${full ? ', full screen' : ''}: 10 queued keep its composer within ${BOUND * 100}% of the window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const { thread, sessions } = await busyRoom(1);
    const root = app.store.items(thread.id).find((i) => i.kind === 'user');
    const { threadId } = app.rt.startTopic(thread.id, root.id);
    await page.goto(`${app.origin}/#/t/${thread.id}/side/${threadId}`);
    await synced(page, app);
    if (full) await page.locator('.sidepanel').getByRole('button', { name: 'Full screen' }).click();
    for (let i = 0; i < 10; i++) app.rt.sendMessage(threadId, { text: `@${sessions[0].handle} follow-up ${i + 1} in the thread` });
    await synced(page, app);
    await settled(page);
    expect(app.store.state.threads[threadId].queue?.length ?? 0, 'the follow-ups are queued').toBe(10);
    const panelShare = await page.evaluate(() => {
      const c = document.querySelector('.sidepanel .composer');
      return (c?.getBoundingClientRect().height ?? 0) / innerHeight;
    });
    expect(panelShare, 'the panel composer’s share of the window').toBeLessThanOrEqual(BOUND);
  });
