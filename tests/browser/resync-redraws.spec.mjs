// #987: what a resync draws again, though a page kept app items’ nodes: what other items read (a term defined, a
// speaker’s latest line, a side thread’s state). Moved from resync-keeps-nodes.spec.mjs.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { away } from './resync-fixture.mjs';

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
