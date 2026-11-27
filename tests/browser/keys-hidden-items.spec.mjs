// Alt+↑/↓ moves between the transcript’s items (keys.mjs), and an item that draws nothing is hidden (#1911): an
// agent’s reply replaced, drawn as an empty hidden node (speaker-line.mjs, drawsNothing). A hidden node can’t take
// focus, so a press that stepped onto it left focus where it was, and seemed to do nothing.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('keys-hidden-items');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('Alt+↑ and Alt+↓ step over a reply that draws nothing, to the message on its other side', async ({ page }) => {
  const { rt, store } = app;
  const project = /** @type {any} */ (Object.values(store.state.projects)[0]);
  const t = rt.createThread({ projectId: project.id, title: 'Hidden between', personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  rt.threads.addItem(t.id, { kind: 'user', text: 'Note: before the hidden reply.' });
  rt.threads.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, text: 'Replaced.', status: 'replaced' });
  rt.threads.addItem(t.id, { kind: 'user', text: 'Note: after the hidden reply.' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const before = page.locator('#main > .item').filter({ hasText: 'Note: before the hidden reply.' });
  const after = page.locator('#main > .item').filter({ hasText: 'Note: after the hidden reply.' });
  await expect(page.locator('#main > .item[hidden]')).toHaveCount(1);

  await page.locator('#composer-input').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(after).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(before, 'one press reaches the message before the hidden reply').toBeFocused();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(after, 'and one press back').toBeFocused();
});

test('Alt+↑ from the composer reaches the newest shown item when the newest draws nothing', async ({ page }) => {
  const { rt, store } = app;
  const project = /** @type {any} */ (Object.values(store.state.projects)[0]);
  const t = rt.createThread({ projectId: project.id, title: 'Hidden last', personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  rt.threads.addItem(t.id, { kind: 'user', text: 'Note: the newest one shown.' });
  rt.threads.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, text: 'Replaced.', status: 'replaced' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('#main > .item').last()).toHaveAttribute('hidden', '');

  await page.locator('#composer-input').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.locator('#main > .item').filter({ hasText: 'Note: the newest one shown.' })).toBeFocused();
});
