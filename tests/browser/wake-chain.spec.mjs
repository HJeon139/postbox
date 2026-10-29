// #492: there’s no limit between two agents. Once agents have chained CHAIN_HINT wakes since your last message, the
// composer says how many, with a hint to Stop them if they’re going nowhere; your next message starts the count again.

import { expect, test } from '@playwright/test';
import { CHAIN_HINT } from '../../shared/limits.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let room;
/** @type {any} */
let quiet;

test.beforeAll(async () => {
  app = await startPostbox('wake-chain');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_chain', name: 'Chain', folder: app.root });
  const personas = ['alpha', 'beta'].map((handle) => rt.createPersona({ handle, backend: 'mock', permissionMode: 'auto', tools: [] }));
  // The count as the server keeps it (agentWake, server/side-threads.mjs); tests/wakes-no-pair-limit.test.mjs shows the
  // wakes themselves going past the old pair limit. Mock agents would answer each other and run it on.
  room = rt.createThread({ projectId: 'pr_chain', title: 'Chain', personaIds: personas.map((p) => p.id) });
  rt.putThread({ ...store.state.threads[room.id], hops: CHAIN_HINT });
  quiet = rt.createThread({ projectId: 'pr_chain', title: 'Quiet', personaIds: personas.map((p) => p.id) });
  rt.putThread({ ...store.state.threads[quiet.id], hops: CHAIN_HINT - 1 });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

for (const width of [1280, 375])
  test(`after ${CHAIN_HINT} chained wakes the composer says how many, and your message clears it (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${app.origin}/#/t/${room.id}`);
    await synced(page, app);
    const hint = page.locator('.composer .hint');
    await expect(hint).toContainText(`Agents have woken each other ${CHAIN_HINT} times since your last message. If they’re going nowhere, Stop them.`);
    await expect(hint.locator('.chain')).toBeVisible();
    if (width !== 375) return;
    app.rt.sendMessage(room.id, { text: '@alpha thanks, that’s enough' });
    await expect(hint.locator('.chain')).toHaveCount(0);
  });

test('below the hint’s count the composer says nothing about the chain', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${quiet.id}`);
  await synced(page, app);
  await expect(page.locator('.composer .hint')).toBeVisible();
  await expect(page.locator('.composer .hint .chain')).toHaveCount(0);
});
