// Whose a “needs you” is, on the page (#1742): what an agent needs of the person who last wrote in the room rings that
// person. For the one looking, its ring pulses, the title counts it and the ring goes to it; for anyone else the agent
// shows that it waits, and nothing rings. A need that names no one rings whoever looks, as before.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('needs-for');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('a need for you pulses, counts and is yours to go to; one for another person only shows that the agent waits', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Whose ask', personaIds: [arrange.persona(rt, 'librarian').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const me = await page.evaluate(() =>
    fetch('/api/state')
      .then((r) => r.json())
      .then((s) => s.config.me.id),
  );
  const ask = arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: 'Which one?', status: 'done' });
  const need = () => rt.sessions.update(se.id, { needs: { kind: 'block', itemId: ask.id, text: 'Which one?' }, state: 'needs' });
  const ring = page.locator(`.rail pb-ring[data-session="${se.id}"]`).first();

  // No one has written here and no one made it through the page: the need names no one, and rings whoever looks.
  need();
  await expect(ring).toHaveAttribute('needs', 'you');
  await expect(ring.locator('.pulse')).toHaveCount(1);
  await expect(page).toHaveTitle(/^\(1\) /);

  // Another person wrote last: the need is theirs. The agent still shows that it waits; nothing rings here.
  rt.sessions.update(se.id, { needs: null, state: 'idle' });
  rt.threads.patch(t.id, { lastPerson: 'pn_someone_else' });
  need();
  await expect(ring).toHaveAttribute('state', 'needs');
  await expect(ring).toHaveAttribute('theirs', 'yes');
  await expect(ring).toHaveAttribute('needs', '');
  await expect(ring.locator('.pulse')).toHaveCount(0);
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
  // In words too: its row and its ring say whom it waits on isn’t you.
  await expect(page.locator('.rail section.agents-sec')).toContainText('waits on another person');
  await expect(ring.getByRole('img')).toHaveAccessibleName(/Waits on another person/);

  // You write: from then on what its agents need is yours.
  rt.sessions.update(se.id, { needs: null, state: 'idle' });
  rt.threads.patch(t.id, { lastPerson: me });
  need();
  expect(rt.store.state.sessions[se.id].needsFor).toEqual([me]);
  await expect(ring).toHaveAttribute('needs', 'you');
  await expect(ring.locator('.pulse')).toHaveCount(1);
  await expect(page).toHaveTitle(/^\(1\) /);
  await expect(page.locator('.rail section.agents-sec')).toContainText('needs you');
});

test('a message you send makes the room’s needs yours, and a room you make is yours before anyone writes', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const personaId = arrange.persona(rt, 'librarian').id;
  // Made before the page loads, so the page has it: no one made it through the page, and no one has written in it.
  const other = rt.createThread({ projectId, title: 'Not yet mine', personaIds: [personaId] });
  expect(rt.store.state.threads[other.id].lastPerson).toBeUndefined();
  await page.goto(`${app.origin}/#/t/${other.id}`);
  await synced(page, app);
  const me = await page.evaluate(() =>
    fetch('/api/state')
      .then((r) => r.json())
      .then((s) => s.config.me.id),
  );
  // Through the route, as the page makes one: the server says who made it, whatever the body says.
  const made = await page.evaluate(
    ([projectId, personaId]) =>
      fetch('/api/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, title: 'Mine', personaIds: [personaId], lastPerson: 'pn_mallory', personId: 'pn_mallory' }),
      }).then((r) => r.json()),
    [projectId, personaId],
  );
  expect(rt.store.state.threads[made.id].lastPerson).toBe(me);
  await page.locator('#composer-input').fill('Hello');
  await page.keyboard.press('Enter');
  await expect.poll(() => rt.store.state.threads[other.id].lastPerson).toBe(me);
});
