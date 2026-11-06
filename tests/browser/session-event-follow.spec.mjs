// What a session event keeps right, now that it paints only what it kept (#564-b1, session-event-scope.spec.mjs): the
// open-asks count after a block is asked again or its side thread goes, the speaker line after the latest reply is
// replaced, and nothing painted off the page after switching conversations back and forth.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('session-event-follow', { demo: false });
  app.store.emit('project', { id: 'pr_follow', name: 'Follow', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const confirm = (id) => ({ id, type: 'confirm', version: 1, fallback: 'Ship it?', statement: `Ship ${id}?`, confirmLabel: 'Ship it' });
let n = 0;
/** A conversation with an open confirm the agent showed, then `replies` exchanges, each reply a turn of its own. */
function room(replies = 2, filler = 0) {
  const { rt } = app;
  const p = rt.createPersona({ handle: `follow${++n}` });
  const t = rt.createThread({ projectId: 'pr_follow', title: `Follow ${n}`, personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.toolsFor(se.id).show_block({ block: confirm('c1') });
  for (let i = 0; i < filler; i++) rt.addItem(t.id, { kind: 'user', text: `Filler ${i}.` });
  for (let i = 0; i < replies; i++) {
    rt.addItem(t.id, { kind: 'user', text: `Question ${i}?` });
    rt.addItem(t.id, {
      kind: 'agent',
      sessionId: se.id,
      personaId: se.personaId,
      handle: se.handle,
      text: `Reply ${i}.`,
      status: 'done',
      turnId: `tu_${n}_${i}`,
    });
  }
  return { t, se };
}
/** A session event, heard and drawn. */
async function sessionEvent(page, se, patch) {
  app.rt.updateSession(se.id, patch);
  await synced(page, app);
  await frames(page);
}
async function open(page, t) {
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await expect(page.locator('#main .item').first()).toBeVisible();
  await synced(page, app);
}
const button = (page, se) => page.locator(`[data-open-asks="${se.id}"]`).first();

test('#564-b1 the open-asks button follows the need, a block asked again, and a side thread removed', async ({ page }) => {
  const { rt, store } = app;
  const { t, se } = room();
  await open(page, t);
  const c1 = store.state.items[t.id].find((x) => x.kind === 'block');
  await sessionEvent(page, se, { needs: { itemId: c1.id, kind: 'block' } });
  await expect(button(page, se), 'the need is not an open ask').toBeHidden();
  await sessionEvent(page, se, { needs: null });
  await expect(button(page, se)).toHaveText('1 open confirmation');
  const side = rt.createThread({ projectId: 'pr_follow', title: 'Side', kind: 'side', parentId: t.id });
  rt.addItem(side.id, { kind: 'block', sessionId: se.id, personaId: se.personaId, handle: se.handle, valid: true, block: confirm('c2'), answered: false });
  await sessionEvent(page, se, { state: 'think' });
  await expect(button(page, se), 'a side thread’s open block counts').toHaveText('2 open confirmations');
  store.emit('remove', { kind: 'thread', id: side.id });
  await sessionEvent(page, se, { state: 'tool' });
  await expect(button(page, se), 'its side thread gone, it doesn’t').toHaveText('1 open confirmation');
  rt.patchItem(t.id, c1.id, { answered: true, answer: { action: 'confirm', values: {}, read: true } });
  await sessionEvent(page, se, { state: 'gen' });
  await expect(button(page, se), 'answered').toBeHidden();
  rt.addItem(t.id, { kind: 'user', text: 'Later.' });
  rt.bringForward(t.id, c1.id, { what: 'block', title: 'c1' }, { answered: false, answer: null, revision: 2 });
  await sessionEvent(page, se, { state: 'idle' });
  await expect(button(page, se), 'asked again, by a move').toHaveText('1 open confirmation');
});

test('#564-b1 when the latest reply is replaced, the reply before it follows the session', async ({ page }) => {
  const { rt, store } = app;
  const { t, se } = room(2);
  await open(page, t);
  const prev = store.state.items[t.id].filter((x) => x.kind === 'agent').at(-1);
  const r = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: 'New.', status: 'done', turnId: 'tu_new' });
  await sessionEvent(page, se, { state: 'idle' });
  rt.patchItem(t.id, r.id, { status: 'replaced', text: '' });
  for (const state of ['think', 'tool', 'gen']) await sessionEvent(page, se, { state });
  const ring = page.locator(`#main [data-key="${prev.id}"] .who pb-ring[data-session="${se.id}"]`);
  await expect(ring, 'the reply before the replaced one follows').toHaveAttribute('state', 'gen');
  const live = await page.evaluate(
    (sid) => [...document.querySelectorAll(`#main .who pb-ring[data-session="${sid}"]`)].filter((x) => x.getAttribute('state') !== 'rest').length,
    se.id,
  );
  expect(live, 'one line follows').toBe(1);
});

test('#564-b1 after switching conversations back and forth, a session event paints nothing off the page', async ({ page }) => {
  test.setTimeout(120_000);
  const a = room(2);
  const b = room(1);
  await open(page, a.t);
  await sessionEvent(page, a.se, { state: 'idle', ctx: 1 });
  // Fewer switches than the lists keep, so a line or button off the page is still on them, and must be skipped.
  for (let i = 0; i < 5; i++) {
    await page.evaluate((id) => (location.hash = `#/t/${id}`), b.t.id);
    await page.waitForFunction((id) => document.querySelector(`#main[data-thread="${id}"]`), b.t.id);
    await page.evaluate((id) => (location.hash = `#/t/${id}`), a.t.id);
    await page.waitForFunction((id) => document.querySelector(`#main[data-thread="${id}"] .item`), a.t.id);
  }
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__offPage = 0;
    const real = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (k, v) {
      // A speaker line’s ring, or an open-asks button, painted while off the page: one kept from a transcript left
      // behind. A ring being built for a new row isn’t one.
      const kept = (this.tagName === 'PB-RING' && this.closest('.who')) || this.dataset?.openAsks;
      if (!this.isConnected && kept) w.__offPage++;
      return real.call(this, k, v);
    };
  });
  for (const state of ['think', 'tool', 'idle']) await sessionEvent(page, a.se, { state });
  expect(await page.evaluate(() => /** @type {any} */ (window).__offPage), 'writes to rings or buttons off the page').toBe(0);
  await expect(page.locator(`#main .who pb-ring[data-session="${a.se.id}"]`).last()).toHaveAttribute('state', 'idle');
});
