// The UAT runner’s conversation action against the real page (tools/uat/conversation-step.mjs, #1735): its delete
// goes through the room’s Manage button, its form in the main menu and the confirm, for a conversation with one
// agent and for a room, and its open still switches conversations afterwards. The runner’s own code, through a
// stand-in for its page.

import { expect, test } from '@playwright/test';
import { driver } from '../../tools/uat/driver.mjs';
import { STEPS } from '../../tools/uat/steps.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { runnerPage } from './runner-page.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('uat-conversation-step');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const api = (/** @type {string} */ path) => fetch(`${app.origin}${path}`).then((r) => r.json());

for (const [what, handles, kind] of /** @type {const} */ ([
  ['a conversation with one agent', ['librarian'], 'thread'],
  ['a room', ['librarian', 'critic'], 'room'],
]))
  test(`the runner deletes ${what} through its Manage button, and then opens another`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the UAT driver works the page through Chromium’s DevTools protocol');
    const { rt } = app;
    const projectId = Object.values(rt.store.state.projects)[0].id;
    const personaIds = handles.map((handle) => arrange.persona(rt, handle).id);
    const gone = rt.createThread({ projectId, title: `Goes (${kind})`, personaIds });
    const stays = rt.createThread({ projectId, title: `Stays (${kind})`, personaIds: [personaIds[0]] });
    expect(rt.store.state.threads[gone.id].kind).toBe(kind);
    await page.goto(`${app.origin}/#/t/${gone.id}`);
    await synced(page, app);
    const ctx = { d: driver(await runnerPage(page)), api, facts: { probes: {} } };
    await expect(STEPS.conversation(ctx, { conversation: 'delete' })).resolves.toMatch(/^Deleted “Goes/);
    expect(rt.store.state.threads[gone.id], 'it is gone').toBeUndefined();
    await expect(page.locator('.backdrop'), 'nothing is left open over the page').toHaveCount(0);
    await STEPS.conversation(ctx, { conversation: 'open', title: stays.title });
    await expect(page).toHaveURL(new RegExp(`#/t/${stays.id}$`));
  });

test('a delete that fails leaves no dialog open, so the runner’s next step finds the page', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the UAT driver works the page through Chromium’s DevTools protocol');
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Fails', personaIds: [arrange.persona(rt, 'librarian').id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const d = driver(await runnerPage(page));
  // The confirm’s Delete is never found: every click before it lands, and that one doesn’t.
  const kit = {
    ...d.kit,
    clickAt: (/** @type {string} */ expr, /** @type {string} */ whatFor) => d.kit.clickAt(whatFor === 'the confirm’s Delete' ? 'null' : expr, whatFor),
  };
  const ctx = { d: { ...d, kit }, api, facts: { probes: {} } };
  await expect(STEPS.conversation(ctx, { conversation: 'delete' })).rejects.toThrow('Couldn’t find the confirm’s Delete on screen.');
  await expect(page.locator('.backdrop')).toHaveCount(0);
  expect(rt.store.state.threads[t.id], 'it is still there').toBeDefined();
});
