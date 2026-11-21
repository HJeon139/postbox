// #948 and #981: what Postbox’s pre-display check found is written for the agent, which gets it as an `app-check`
// message or a lint turn. The person sees a plain status instead: while the agent fixes a first version, a note that
// it’s being fixed; while it fixes a later one, the version before it; and on an app shown with problems, a short note
// in plain words, with no pixel sizes or CSS advice.
// The check’s messages here are the ones the UATs quoted from the page (the issues’ “What failed instead”).

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const APP = (label) => `<main style="padding:12px"><p>${label}</p></main>`;
// #948’s placeholder and #981’s banner, as the testers quoted them.
const FIXING = [
  { code: 'text-too-small', message: '13 of 20 labels are drawn under 9 px.' },
  { code: 'class-clash', message: 'The class .sp-head is also defined by Postbox’s stylesheet.' },
];
const NOTED = [{ code: 'overlap-375', message: 'At 375 px, ‘never’ is drawn over ‘1 per 3 mo’ (3 × 12 px). Give path pointer-events: none.' }];
/** Words written for the agent that the person shouldn’t see. */
const AGENT_WORDS = /\bpx\b|\.sp-head|pointer-events|stylesheet/;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-check-plain');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A conversation with one agent app that passed its check, and a way to set what the check found. */
async function seed(page, id) {
  const { rt, store } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: `Check ${id}`, personaIds: [arrange.persona(rt, 'researcher').id] });
  const [tools] = arrange.sessionsIn(rt, t.id).map((se) => rt.toolsFor(se.id));
  const item = () => page.locator(`.transcript > [data-key="${rt.store.state.apps[id].itemId}"]`);
  const passed = () => expect.poll(() => rt.store.state.apps[id].check.status, { message: `${id} passes its own check`, timeout: 15_000 }).toBe('passed');
  const found = async (check) => {
    store.emit('app', { ...rt.store.state.apps[id], check });
    await synced(page, app);
  };
  // SHOTS=<folder> saves the app’s place in the conversation, for the pull request’s before and after.
  const shoot = async (name) => {
    if (!process.env.SHOTS) return;
    await item().screenshot({ path: join(process.env.SHOTS, `${name}.png`) });
  };
  tools.show_app({ id, title: 'Sleep and running', code: APP('Version 1') });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await passed();
  return { tools, item, passed, found, shoot };
}

test('#948 while the agent fixes a first version, the person sees a plain status, not the check’s findings', async ({ page }) => {
  const { item, found, shoot } = await seed(page, 'first');
  await found({ status: 'fixing', attempt: 1, problems: FIXING });
  const placeholder = item().locator('.app-placeholder');
  await expect(placeholder).toContainText('researcher is fixing this app before you see it');
  await expect(placeholder, 'none of the check’s words for the agent').not.toContainText(AGENT_WORDS);
  await shoot('948-fixing-first');
});

test('#948 while the agent fixes a later version, the person sees the version before it', async ({ page }) => {
  const { tools, item, passed, found, shoot } = await seed(page, 'later');
  tools.update_app({ id: 'later', code: APP('Version 2'), summary: 'bigger labels' });
  await passed();
  await found({ status: 'fixing', attempt: 1, problems: FIXING });
  await expect(item().locator('iframe.app-iframe'), 'v1’s frame').toHaveAttribute('src', /\/sandbox\/app\/later\/1\?/);
  await expect(item().locator('.app-note')).toHaveText('researcher is fixing v2. Until then, this is v1, read-only.');
  await expect(item(), 'none of the check’s words for the agent').not.toContainText(AGENT_WORDS);
  // The version menu names the version on screen, not the one being fixed.
  await item().locator('[aria-haspopup="menu"]').click();
  await expect(page.getByRole('menuitem', { name: /^v1\b/ }), 'v1 is the one marked in the menu').toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await shoot('948-fixing-later');
});

for (const [id, check, text] of [
  ['noted', { problems: NOTED }, 'Some text or marks here may be hard to read or use.'],
  ['told', { problems: NOTED, told: true }, 'Some text or marks here may be hard to read or use. researcher has the details.'],
  [
    'erring',
    { problems: [{ code: 'only-error', message: 'The app shows only an error.' }], told: true },
    'It may be showing an error in place of what it’s for. researcher has the details.',
  ],
])
  test(`#981 an app shown with notes says so in plain words (${id})`, async ({ page }) => {
    const { item, found, shoot } = await seed(page, id);
    await found({ status: 'note', attempt: 0, notes: true, ...check });
    await expect(item().locator('.app-note')).toHaveText(text);
    await shoot(`981-note-${id}`);
  });

test('#981 an app shown with problems its agent couldn’t fix says so in plain words', async ({ page }) => {
  const { item, found, shoot } = await seed(page, 'unfixed');
  await found({ status: 'note', attempt: 1, problems: NOTED, told: true });
  await expect(item().locator('.app-note')).toHaveText(
    'Shown with problems researcher couldn’t fix. Parts of it may be hard to read or use. researcher has the details.',
  );
  await shoot('981-note-unfixed');
});

test('#981 an app Postbox couldn’t finish checking says that, not the check’s error', async ({ page }) => {
  const { item, found } = await seed(page, 'unchecked');
  await found({ status: 'note', attempt: 0, problems: [{ code: 'check-error', message: 'At 1000 px, Postbox couldn’t check for contrast: no matrix' }] });
  await expect(item().locator('.app-note')).toHaveText('Postbox couldn’t finish checking this app, so it’s shown as it is.');
});
