// #987: what a resync draws again, though a page kept app items’ nodes: what other items read (a term defined, a
// speaker’s latest line, a side thread’s state), an app item whose own record changed, and an app item that was the
// agent’s latest line, which rests once a later reply arrived.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';
import { away, mark, room, seen } from './resync-fixture.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('resync-redraws');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#987 a resync redraws what other items read: a term defined, a speaker’s latest reply, a side thread’s state', async ({ page }) => {
  const { rt, store } = app;
  const researcher = arrange.persona(rt, 'researcher');
  const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Resync, reads', personaIds: [researcher.id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  const side = arrange.putThread(rt, {
    ...{ id: `th_side${t.id.slice(3)}`, projectId: t.projectId, title: 'researcher ↔ critic', kind: 'side', parentId: t.id },
    ...{ pair: 'critic|researcher', woke: 'researcher', members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: Date.now() },
  });
  const reply = (/** @type {string} */ text) =>
    arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  reply('The index uses [BM25](term:bm25) to rank pages.');
  arrange.post(rt, t.id, { kind: 'sidelink', sideThreadId: side.id, from: 'critic', to: 'researcher', count: 1 });
  arrange.setSession(rt, se.id, { state: 'tool', sideTurn: { threadId: side.id } });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('#main .term.undef')).toHaveCount(1);
  await expect(page.locator('#main .who-state').filter({ hasText: /\S/ })).toHaveCount(1);
  await expect(page.locator('#main .col.sys')).toContainText('researcher is calling tools');
  const resync = await away(app, page);
  store.emit('glossary', { threadId: t.id, entry: { key: 'bm25', term: 'BM25', definition: 'A ranking function.' } });
  reply('A newer reply, now the latest.');
  arrange.setSession(rt, se.id, { state: 'idle', sideTurn: null });
  arrange.setSession(rt, se.id, { state: 'tool' });
  await resync();
  await expect(page.locator('#main .term.undef'), 'the term defined while away is marked as defined').toHaveCount(0);
  await expect(page.locator('#main .who-state').filter({ hasText: /\S/ }), 'only the latest reply’s line follows the agent').toHaveCount(1);
  await expect(page.locator('#main .col.sys'), 'the side thread’s line shows the agent’s state now').not.toContainText('researcher is calling tools');
});

test('#987 an app item whose own record changed while away, as by a reaction, draws again', async ({ page }) => {
  const { t, ids } = await room(app, page, 'Resync, a reaction', 4, 2);
  await mark(page);
  const items = app.store.items(t.id);
  const itemOf = (/** @type {string} */ appId) => /** @type {any} */ (items.find((i) => i.block?.id === appId)).id;
  const resync = await away(app, page);
  arrange.react(app.rt, t.id, itemOf(ids[0]), '👍', 'you');
  await resync();
  const after = await seen(page);
  expect(after.newApps, 'the app item with a reaction draws again').toContain(itemOf(ids[0]));
  expect(after.newApps.includes(itemOf(ids[1])), 'the other app keeps its node').toBe(false);
});

test('#987 a kept app item that was the agent’s latest line rests once a later reply arrived while away', async ({ page }) => {
  const { rt } = app;
  const { t } = await room(app, page, 'Resync, the latest line', 3, 1);
  const se = arrange.agentIn(rt, t.id);
  arrange.setSession(rt, se.id, { state: 'think' });
  const appItem = /** @type {any} */ (app.store.items(t.id).find((i) => i.block?.type === 'app'));
  const words = page.locator(`#main > .item[data-key="${appItem.id}"] .who-state`);
  await expect(words, 'the app item’s line follows the agent').toHaveText('· thinking');
  await settled(page);
  await mark(page);
  const resync = await away(app, page);
  // The person speaks, then the agent: its later reply names it on a line of its own.
  arrange.post(rt, t.id, { kind: 'user', text: 'And then?' });
  arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: 'A later reply.', status: 'done' });
  await resync();
  expect((await seen(page)).newApps, 'the app item is kept').toEqual([]);
  await expect(words, 'its line rests: the later reply follows the agent now').toHaveText('');
});
