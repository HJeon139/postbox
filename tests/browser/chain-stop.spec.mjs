// The wake chain’s loop guard (#1623; designs/intent.md, principle 6): at the cap of agent wakes in a row without you,
// the next one doesn’t go, and the room shows one line, with no card and nothing to answer. A wake-limit card from
// before shows what became of it, with no buttons, and an old wake line no longer counts toward a limit. The add card
// (#228) still asks, and still sends the wakes held on it when you answer (#439).

import { expect, test } from '@playwright/test';
import { HOP_LIMIT } from '../../shared/limits.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let stopped;
/** @type {any} */
let oldRoom;
/** @type {any} */
let addRoom;

const LINE = 'Agents stopped waking each other after 1,000 wakes in a row. Your next message lets them start again.';

test.beforeAll(async () => {
  app = await startPostbox('chain-stop');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_wakes', name: 'Wakes', folder: app.root });
  const mock = (handle) => rt.createPersona({ handle, backend: 'mock', permissionMode: 'auto', tools: [] });
  const personas = ['waker', 'woken'].map(mock);
  const other = mock('other');
  const room = (title) => rt.createThread({ projectId: 'pr_wakes', title, personaIds: personas.map((p) => p.id) });
  // A chain at the cap, its count set directly rather than 1,000 wakes: the next two wakes don’t go.
  stopped = room('Stopped');
  arrange.setThread(rt, stopped.id, { hops: HOP_LIMIT });
  const waker = arrange.agentIn(rt, stopped.id, 'waker');
  const woken = arrange.agentIn(rt, stopped.id, 'woken');
  arrange.wake(rt, waker.id, 'woken', 'check 1,001');
  arrange.wake(rt, woken.id, 'waker', 'and back');
  // What a room from before #1623 kept: a wake line with its number, and a wake-limit card.
  oldRoom = room('Old card');
  const ow = arrange.agentIn(rt, oldRoom.id, 'waker');
  arrange.post(rt, oldRoom.id, { kind: 'system', variant: 'wake', from: 'waker', to: 'woken', n: 3, limit: 3 });
  arrange.post(rt, oldRoom.id, {
    kind: 'hop',
    fromSessionId: ow.id,
    from: 'waker',
    to: 'woken',
    text: 'check 4',
    reason: 'check 4',
    status: 'open',
    n: 4,
    limit: 3,
  });
  // An add card, and woken’s wake of the same agent held on it.
  addRoom = room('Add');
  arrange.wake(rt, arrange.agentIn(rt, addRoom.id, 'waker').id, other.handle, 'count the lines in work/');
  arrange.wake(rt, arrange.agentIn(rt, addRoom.id, 'woken').id, other.handle, 'and the words');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#1623 at the cap the room shows one line, with no card, no button and nothing waiting on you', async ({ page }) => {
  expect(HOP_LIMIT, 'the cap the line names').toBe(1000);
  await page.goto(`${app.origin}/#/t/${stopped.id}`);
  await synced(page, app);
  const transcript = page.locator('.transcript');
  await expect(transcript.locator('.sys-line').filter({ hasText: LINE })).toHaveCount(1);
  await expect(transcript.locator('.block').filter({ hasText: 'wake' })).toHaveCount(0);
  await expect(transcript.getByRole('button', { name: /wake/i })).toHaveCount(0);
  await expect(transcript).not.toContainText('check 1,001');
  // Nothing needs you here: no glyph on the card that isn’t there, nor on the room’s row (another room’s add card has one).
  await expect(transcript.locator('.g-needs')).toHaveCount(0);
  await expect(page.locator(`.rail a.row[data-thread="${stopped.id}"] .g-needs`)).toHaveCount(0);
  await expect(page.locator(`.rail a.row[data-thread="${addRoom.id}"]`)).toBeVisible();
});

test('#1623 a wake-limit card from before shows as a line with no buttons, and an old wake line names no limit', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${oldRoom.id}`);
  await synced(page, app);
  const transcript = page.locator('.transcript');
  await expect(transcript.locator('.sys-line').filter({ hasText: 'waker asked to wake woken' })).toHaveCount(1);
  await expect(transcript.getByRole('button', { name: /wake/i })).toHaveCount(0);
  await expect(transcript.locator('.sys-line').filter({ hasText: 'waker woke woken' })).toBeVisible();
  await expect(transcript).not.toContainText('agent wake');
});

test('#439 an add card shows the wake held on it, and Add sends it too', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${addRoom.id}`);
  await synced(page, app);
  const card = page.locator('.transcript .block').filter({ hasText: 'Add other to this conversation?' });
  await expect(card.locator('.hop-held')).toContainText('Also waiting on your answer: woken’s message to other');
  await card.getByRole('button', { name: 'Add other', exact: true }).click();
  await expect(card).toContainText('Added');
  await expect(card.locator('.hop-held')).toHaveCount(0);
  await expect(page.locator('.transcript')).toContainText('and the words');
});
