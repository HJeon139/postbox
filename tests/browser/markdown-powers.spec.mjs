// #793: a person’s message with code or math, “range(10**9, 10**10)”, showed as “range(109, 1010)” with “9, 10” in
// bold: its ** pairs were read as emphasis. It shows as typed, in the person’s message and in an agent’s reply.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('markdown-powers');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#793 range(10**9, 10**10) shows as typed, in a message and in a reply, with nothing in bold', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const librarian = arrange.persona(rt, 'librarian');
  const t = rt.createThread({ projectId, title: 'Powers', personaIds: [librarian.id] });
  const se = arrange.agentIn(rt, t.id);
  arrange.post(rt, t.id, { kind: 'user', text: 'Try range(10**9, 10**10).' });
  arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: librarian.id, handle: 'librarian', text: 'That is x**2 + y**2 steps.', status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('.transcript').getByText('Try range(10**9, 10**10).', { exact: true })).toBeVisible();
  await expect(page.locator('.transcript').getByText('That is x**2 + y**2 steps.', { exact: true })).toBeVisible();
  await expect(page.locator('.transcript strong, .transcript em')).toHaveCount(0);
});
