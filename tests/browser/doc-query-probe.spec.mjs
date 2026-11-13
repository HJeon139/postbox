// #564-b1’s UAT probe on a real page (tools/uat/doc-query-probe.mjs): in a 1,000-item room, with an open ask, the
// samples a run records each step, and the trigger that reads them (tools/uat/view-triggers.mjs, session-scoped).
// POSTBOX_DOC_QUERY_SAMPLES names a file to write the samples to, to record them for tests/uat-doc-query-probe.test.mjs.

import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { sampleDocQueries } from '../../tools/uat/doc-query-probe.mjs';
import { VIEW_TRIGGERS } from '../../tools/uat/view-triggers.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

// No trace: its snapshots walk the whole page around each action, which a 1,000-item room makes slow.
test.use({ trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('doc-query-probe', { demo: false });
  app.store.emit('project', { id: 'pr_probe', name: 'Probe', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const confirm = { id: 'ok1', type: 'confirm', version: 1, fallback: 'Ship it?', statement: 'Ship it to main?', confirmLabel: 'Ship it' };

test('#564-b1 the probe hears session events in a 1,000-item room, and session-scoped fires on what it records', async ({ page }) => {
  test.setTimeout(180_000);
  const { rt } = app;
  const p = rt.createPersona({ handle: 'prober' });
  const t = rt.createThread({ projectId: 'pr_probe', title: 'Probe', personaIds: [p.id] });
  const se = arrange.agentIn(rt, t.id);
  rt.toolsFor(se.id).show_block({ block: confirm });
  for (let i = 0; i < 999; i++)
    arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: `Reply ${i}.`, status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await expect(page.locator('#main .item').first()).toBeAttached({ timeout: 90_000 });
  await synced(page, app);
  const ev = (/** @type {string} */ expr) => page.evaluate(expr);
  const samples = [{ step: 1, at: Date.now(), ...(await sampleDocQueries(ev)) }];
  expect(samples[0], 'installed: nothing counted yet').toMatchObject({ sessionEvents: 0, scanCount: 0, items: 1000 });
  for (const [i, state] of ['think', 'tool', 'gen', 'idle', 'think', 'idle'].entries()) {
    arrange.setSession(rt, se.id, { state });
    // An event of another kind between them, which the probe mustn't count as a session event.
    if (i === 2) arrange.post(rt, t.id, { kind: 'user', text: 'Between.' });
    await synced(page, app);
    await frames(page);
    if (i % 2) samples.push({ step: samples.length + 1, at: Date.now(), ...(await sampleDocQueries(ev)) });
  }
  if (process.env.POSTBOX_DOC_QUERY_SAMPLES) writeFileSync(process.env.POSTBOX_DOC_QUERY_SAMPLES, `${JSON.stringify(samples, null, 2)}\n`);
  const last = samples[samples.length - 1];
  expect(last.sessionEvents, 'the probe heard every session event').toBe(6);
  expect(last.scans, 'no lookup over the whole document').toEqual([]);
  const hits = VIEW_TRIGGERS['session-scoped'].run({ probes: { docQueries: samples } });
  expect(hits.map((h) => h.evidence)).toEqual([expect.stringMatching(/handled \d+ session events in a conversation of 1001 items/)]);
});
