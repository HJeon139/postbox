// #1035: a room sets its own wake chain limit from its “Actions for …” menu, by keyboard alone. The field shows the
// server’s default; a bad value is refused inline and the dialog stays open with what was typed; a saved limit is what
// the composer’s hint names and what the next wake is held at; “Use the default” clears it; and focus goes back to the
// menu’s button when the dialog closes.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { allowPageError, failOnPageErrors, focusIs, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {Record<number, any>} */
const rooms = {};

test.beforeAll(async () => {
  app = await startPostbox('room-chain-limit');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_limit', name: 'Limits', folder: app.root });
  const personas = ['waker', 'woken'].map((handle) => rt.createPersona({ handle, backend: 'mock', permissionMode: 'auto', tools: [] }));
  for (const width of [1280, 375]) rooms[width] = rt.createThread({ projectId: 'pr_limit', title: `Limit ${width}`, personaIds: personas.map((p) => p.id) });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const TAKES = 'A room’s wake chain limit is a whole number from 1 to 10,000.';

/** The room’s menu button, the dialog and its field, and a way to open the dialog by keyboard: the item after Rename…. */
function controls(page, room) {
  const actions = page.getByRole('button', { name: `Actions for ${room.title}` });
  const dialog = page.getByRole('dialog', { name: 'Wake chain limit' });
  const field = dialog.getByRole('spinbutton', { name: 'Agent wakes in a row' });
  const open = async () => {
    await actions.focus();
    await page.keyboard.press('Enter');
    await focusIs(page, 'menuitem: Rename…');
    await page.keyboard.press('ArrowDown');
    await focusIs(page, /^menuitem: Wake chain limit…/);
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(field).toBeFocused();
  };
  return { actions, dialog, field, open, conv: () => app.store.state.threads[room.id] };
}

/** Six wakes at once, as a chain runs, so no turn’s end starts the count again (#492): the sixth past the room’s 5. */
function sixWakes(room) {
  const waker = arrange.agentIn(app.rt, room.id, 'waker');
  for (let i = 0; i < 5; i++) arrange.wake(app.rt, waker.id, 'woken', `check ${i + 1}`, { confirmed: true });
  arrange.wake(app.rt, waker.id, 'woken', 'the sixth');
}

for (const width of [1280, 375])
  test(`#1035 the room’s menu sets its wake chain limit by keyboard, which the hint and the next wake use (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const room = rooms[width];
    await page.goto(`${app.origin}/#/t/${room.id}`);
    await synced(page, app);
    const { actions, dialog, field, open, conv } = controls(page, room);

    await test.step('the field shows the default, and a bad value is refused inline, keeping the dialog and what was typed', async () => {
      await open();
      allowPageError(page, /status of 422/); // the refusal this step asks for
      await expect(field).toHaveValue('');
      await expect(field).toHaveAttribute('placeholder', '1,000');
      await page.keyboard.type('10001');
      await page.keyboard.press('Enter');
      await expect(dialog.getByRole('alert')).toHaveText(TAKES);
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(field).toHaveValue('10001');
      expect(conv().chainLimit).toBeUndefined();
    });

    await test.step('5, saved, closes the dialog with focus back on the menu’s button', async () => {
      await field.press('ControlOrMeta+a');
      await page.keyboard.type('5');
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => conv().chainLimit).toBe(5);
      await expect(actions).toBeFocused();
    });

    await test.step('the sixth wake waits on a card past 5, and the hint names the room’s 5 from its fifth wake', async () => {
      sixWakes(room);
      const card = page.locator('.transcript .block').filter({ hasText: 'Let waker wake woken?' });
      await expect(card).toContainText('That would be agent wake 6 in this chain, past the limit of 5, so it waits for you.');
      await expect(page.locator('.composer .hint .chain')).toHaveText(
        'Agents have woken each other 5 times since your last message, of the room’s limit of 5. If they’re going nowhere, Stop them.',
      );
    });

    await test.step('“Use the default” clears it, and focus goes back to the menu’s button', async () => {
      await open();
      await expect(field).toHaveValue('5');
      const useDefault = dialog.getByRole('button', { name: 'Use the default' });
      for (let i = 0; i < 6 && !(await useDefault.evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('Tab');
      await expect(useDefault).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => conv().chainLimit).toBeNull();
      await expect(actions).toBeFocused();
    });
  });
