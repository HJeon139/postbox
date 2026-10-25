// Whom the composer says a message reaches, typed as a person types:
// - a draft that opens with an agent’s name and “:” or “,”, in a room where another agent spoke last, shows “Did you
//   mean @critic?”, whose one click adds the @; a name later in the draft, or the last speaker’s own, shows nothing
//   (#134, the rule the end-to-end tester uses);
// - a topic thread says who an unaddressed message goes to, “Replying to @x”, as the conversation does (#134); side
//   threads have no composer since #372, so no hint either;
// - a draft that @-mentions an agent says it wakes that one, and not the agent it would otherwise go to (#107).
// On the demo’s mock agents, each test in a room of its own where @researcher spoke last. Moved from
// tools/checks/composer-address.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, focusIs, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('composer-address');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A room of its own with @critic and @researcher, where @researcher spoke last, open in the page. */
async function room(page, title) {
  const { rt, store } = app;
  const t = rt.createThread({
    projectId: Object.keys(store.state.projects)[0],
    title,
    personaIds: ['critic', 'researcher'].map((h) => rt.personaByHandle(h).id),
  });
  const researcher = rt.sessionsIn(t.id).find((x) => x.handle === 'researcher');
  const said = rt.addItem(t.id, {
    kind: 'agent',
    sessionId: researcher.id,
    personaId: researcher.personaId,
    handle: 'researcher',
    text: 'Revision 3 is up.',
    status: 'done',
  });
  rt.putThread({ ...store.state.threads[t.id], lastSpeaker: researcher.id });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('#composer-input')).toBeVisible();
  return { t, researcher, said };
}
const hint = (page, input) => page.locator(`.composer:has(#${input}) .hint`);
/** Empties a composer and types into it, as a keyboard’s text input does. */
async function typeIn(page, input, value) {
  await page.locator(`#${input}`).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(value);
}

test('#134 “critic: …” shows “Did you mean @critic?”, and its click adds the @', async ({ page }) => {
  await room(page, 'Did you mean');
  await typeIn(page, 'composer-input', 'critic: what’s your biggest concern?');
  await expect(hint(page, 'composer-input')).toContainText('Did you mean @critic?');
  await expect(hint(page, 'composer-input'), 'it says who it goes to').toContainText('Replying to @researcher');
  await hint(page, 'composer-input').locator('.did-you-mean').click();
  await expect(page.locator('#composer-input')).toHaveValue('@critic: what’s your biggest concern?');
  await expect(page.locator('#composer-input'), 'focus back in the composer').toBeFocused();
  await expect(hint(page, 'composer-input'), 'it no longer asks').not.toContainText('Did you mean');
});

test('#134 by keyboard: the suggestion is announced, keeps focus while the page repaints, and Enter adds the @', async ({ page }) => {
  const { researcher } = await room(page, 'By keyboard');
  await typeIn(page, 'composer-input', '  critic, one question');
  await expect(page.locator('#live'), 'announced').toHaveText(/^Did you mean @critic\?/);
  await hint(page, 'composer-input').locator('.did-you-mean').focus();
  // Anything an agent does repaints the composer.
  app.rt.updateSession(researcher.id, { currentStep: 'Reading revision 3' });
  await synced(page, app);
  await focusIs(page, /did you mean @critic/i);
  await page.keyboard.press('Enter');
  await expect(page.locator('#composer-input')).toHaveValue('  @critic, one question');
});

test('#134 “Researcher, …” to the last speaker, and a name later in the draft, show no hint', async ({ page }) => {
  await room(page, 'No hint');
  for (const draft of ['Researcher, did you fix it?', 'What did the critic find?', 'the critics agree']) {
    await typeIn(page, 'composer-input', draft);
    // The composer redraws its hint as each key’s input comes, as the first test’s Did you mean shows.
    await expect(hint(page, 'composer-input')).toContainText('Replying to @researcher');
    await expect(hint(page, 'composer-input'), `“${draft}” shows no hint`).not.toContainText('Did you mean');
  }
});

test('#107 replying while mentioning another agent says it wakes that one, not the last speaker', async ({ page }) => {
  await room(page, 'Wakes');
  await typeIn(page, 'composer-input', '@critic what do you make of revision 3?');
  await expect(hint(page, 'composer-input')).toContainText('Wakes @critic, not @researcher (last speaker)');
  await expect(hint(page, 'composer-input'), 'not that it replies to the last speaker').not.toContainText('Replying to');
  await typeIn(page, 'composer-input', '@critic and @researcher, both of you');
  await expect(hint(page, 'composer-input')).toContainText('Wakes @critic, @researcher');
  await expect(hint(page, 'composer-input')).not.toContainText(', not ');
});

test('#134 a topic thread says who an unaddressed message goes to', async ({ page }) => {
  const { t, said } = await room(page, 'Topic');
  const { threadId } = app.rt.startTopic(t.id, said.id);
  // Only the hash changes, so the page doesn’t load again: the thread must have reached it first.
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}/side/${threadId}`);
  await synced(page, app);
  await expect(hint(page, 'side-input')).toContainText('Replying to @researcher');
  await typeIn(page, 'side-input', 'critic, is this right?');
  await expect(hint(page, 'side-input')).toContainText('Did you mean @critic?');
});
