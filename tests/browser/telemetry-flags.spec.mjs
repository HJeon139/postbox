// The UAT’s 🚩 on a finding’s item (#483): the runner reacts through the page, as a person does
// (tools/uat/telemetry-driver.mjs). Since reactions became inline buttons (#320), the driver looked for the old React
// menu, so every 🚩 failed with “Couldn’t find the React button”. These are the six item ids of a hostwakes run of
// 27 October 2026 whose six flags failed so, on agent messages as that run’s store held them.

import { expect, test } from '@playwright/test';
import { telemetryDriver } from '../../tools/uat/telemetry-driver.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const IDS = ['it_2gWnpws5', 'it_VKBitURC', 'it_aSLVoZNk', 'it_DqKYXs3l', 'it_jBnFdL1C', 'it_5sqbMK8e'];

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let thread;

test.beforeAll(async () => {
  app = await startPostbox('telemetry-flags');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_flags', name: 'Flags', folder: app.root });
  const persona = rt.createPersona({ handle: 'flagged', backend: 'mock', permissionMode: 'auto', tools: [] });
  thread = rt.createThread({ projectId: 'pr_flags', title: 'Hand-offs', personaIds: [persona.id] });
  const se = rt.sessionsIn(thread.id)[0];
  for (const [i, id] of IDS.entries())
    store.emit('item.add', {
      threadId: thread.id,
      item: {
        id,
        kind: 'agent',
        sessionId: se.id,
        personaId: persona.id,
        handle: 'flagged',
        turnId: `turn_${i}`,
        text: `Reply ${i + 1}.`,
        status: 'done',
        at: Date.now() + i,
      },
    });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('the runner’s 🚩 lands on each of the six items whose flags failed (#483)', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const td = telemetryDriver({ evaluate: (expr) => page.evaluate(expr) });
  for (const id of IDS) await td.react(id, '🚩');
  await expect.poll(() => IDS.filter((id) => app.store.item(thread.id, id)?.reactions?.some((r) => r.emoji === '🚩' && !r.by)).length).toBe(IDS.length);
});
