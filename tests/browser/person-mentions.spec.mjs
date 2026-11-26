// A mention of a person on the page (#1742), through a real turn: an agent’s reply that says @you to the person it
// answers makes it need them, with its ring, the title’s count and ⌃J as for any need, and opening the room reads it,
// which is its answer. With the room open as it lands, nothing rings.

import { expect, test } from '@playwright/test';
import { HarnessEvents } from '../../server/harness-events.mjs';
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

/** The next turn of the scripted backend says `text` and ends, in place of its script. */
function nextReply(/** @type {string} */ text) {
  const mock = app.rt.adapters.get('mock');
  const scripted = mock.deliver;
  mock.deliver = async (/** @type {any} */ _session, /** @type {any} */ _given, /** @type {any} */ ctx) => {
    mock.deliver = scripted;
    new HarnessEvents(ctx).event({ kind: 'text', text, block: 'reply' });
  };
}
const quiet = () => expect.poll(() => arrange.liveTurns(app.rt) + arrange.exitingTurns(app.rt), { message: 'the agents to finish' }).toBe(0);

test('a reply that says @you rings you from another room, ⌃J goes to it, and reading it there clears it', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Asked here', personaIds: [arrange.persona(rt, 'librarian').id] });
  const away = rt.createThread({ projectId, title: 'Elsewhere', personaIds: [arrange.persona(rt, 'critic').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  await quiet();
  for (const s of Object.values(rt.store.state.sessions)) if (s.needs) rt.sessions.update(s.id, { needs: null, state: 'idle' });
  // In another room: a room counts as open for a while after a page last said so, so this page never opens the one asked in.
  await page.goto(`${app.origin}/#/t/${away.id}`);
  await synced(page, app);
  nextReply('Done. @you should look at the totals.');
  const me = await page.evaluate(() =>
    fetch('/api/state')
      .then((r) => r.json())
      .then((s) => s.config.me.id),
  );
  // Sent as the page sends it, from the other room, so no page has the asked room open when the reply lands.
  await page.evaluate(
    (id) =>
      fetch(`/api/threads/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Check the totals' }),
      }),
    t.id,
  );
  await quiet();
  const reply = rt.store.items(t.id).findLast((i) => i.kind === 'agent');
  expect([reply?.asks, rt.store.state.sessions[se.id].needs?.kind, rt.store.state.sessions[se.id].needsFor]).toEqual([[me], 'mention', [me]]);
  await expect(page).toHaveTitle(/^\(1\) /);
  await expect(page.locator('#next-needs')).toContainText('Next that needs you');
  // ⌃J goes to the room it asked in, and having it open is reading it: the need is gone, with nothing to press.
  await page.keyboard.press('Control+j');
  await expect(page).toHaveURL(new RegExp(`#/t/${t.id}`));
  await expect.poll(() => rt.store.state.sessions[se.id].needs).toBeNull();
  expect(rt.store.items(t.id).find((i) => i.id === reply?.id)?.asksSeen).toBe(true);
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
  await expect(page.locator(`.rail pb-ring[data-session="${se.id}"]`).first()).toHaveAttribute('needs', '');
});

test('with the room open as the reply lands, a reply that says @you rings nothing', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Watched', personaIds: [arrange.persona(rt, 'librarian').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  await quiet();
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  nextReply('Done, @you can look.');
  await page.locator('#composer-input').fill('Go');
  await page.keyboard.press('Enter');
  await expect(page.locator('#main .turn', { hasText: 'Done, @you can look.' })).toBeVisible();
  await quiet();
  const reply = rt.store.items(t.id).findLast((i) => i.kind === 'agent');
  expect([reply?.asksSeen, rt.store.state.sessions[se.id].needs]).toEqual([true, null]);
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
});
