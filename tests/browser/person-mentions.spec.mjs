// A mention of a person on the page (#1742): an agent’s reply that asks you makes it need you, with its ring, the
// title’s count and ⌃J as for any need, and opening the room reads it, which is its answer.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('person-mentions');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('a reply that asks you counts as needing you from elsewhere, ⌃J goes to it, and reading it there clears it', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Asked here', personaIds: [arrange.persona(rt, 'librarian').id] });
  const away = rt.createThread({ projectId, title: 'Elsewhere', personaIds: [arrange.persona(rt, 'critic').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  await expect.poll(() => arrange.liveTurns(rt) + arrange.exitingTurns(rt)).toBe(0);
  for (const s of Object.values(rt.store.state.sessions)) if (s.needs) rt.sessions.update(s.id, { needs: null, state: 'idle' });
  await page.goto(`${app.origin}/#/t/${away.id}`);
  await synced(page, app);
  // The reply as a turn leaves it: marked with whom it asks (no one named, so the person it answers), and the need it makes.
  const reply = arrange.post(rt, t.id, {
    kind: 'agent',
    sessionId: se.id,
    personaId: se.personaId,
    handle: se.handle,
    text: 'Done. @you should look at the totals.',
    status: 'done',
    asks: [],
  });
  rt.sessions.update(se.id, { needs: { kind: 'mention', itemId: reply.id, text: 'Done. @you should look at the totals.' }, state: 'needs' });
  await expect(page).toHaveTitle(/^\(1\) /);
  await expect(page.locator('#next-needs')).toContainText('Next that needs you');
  // ⌃J goes to the room it asked in, and having it open is reading it: the need is gone, with nothing to press.
  await page.keyboard.press('Control+j');
  await expect(page).toHaveURL(new RegExp(`#/t/${t.id}`));
  await expect.poll(() => rt.store.state.sessions[se.id].needs).toBeNull();
  expect(rt.store.items(t.id).find((i) => i.id === reply.id)?.asksSeen).toBe(true);
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
  await expect(page.locator(`.rail pb-ring[data-session="${se.id}"]`).first()).toHaveAttribute('needs', '');
});
