// #297 inside one frame (#903’s follow-up): while following, a change, then a shrink that a forced layout from
// elsewhere sees, then the page growing again, all before the frame. The browser pulls the view up to the shrunk end,
// and that scroll’s event, coming after the page grew, mustn’t read as you scrolling up. The watcher reads once a
// frame (#866), and at once for a batch that only removes; a redraw that removes and adds is left to the frame’s note.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room = '';
test.beforeAll(async () => {
  app = await startPostbox('follow-shrink-in-frame');
  const projectId = Object.values(app.rt.store.state.projects)[0].id;
  room = app.rt.createThread({ projectId, title: 'Followed', personaIds: [] }).id;
  for (let i = 0; i < 60; i++) app.store.emit('item.add', { threadId: room, item: { id: `it_s${i}`, at: Date.now(), kind: 'user', text: `Line ${i}` } });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#297 in one frame: a change, then a shrink that a forced layout sees, then growing back, leaves the view following', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${room}`);
  await synced(page, app);
  await settled(page);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
  // A tall block in the last item, as a review or an app is, that a change can take out and put back.
  await page.evaluate(() => {
    const big = document.createElement('div');
    big.id = 'pb-big';
    big.style.height = '600px';
    [...document.querySelectorAll('#main > .item')].at(-1)?.append(big);
  });
  await settled(page);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
  await page.evaluate(async () => {
    const items = [...document.querySelectorAll('#main > .item')];
    const last = /** @type {HTMLElement} */ (items.at(-2));
    const big = /** @type {HTMLElement} */ (document.getElementById('pb-big'));
    last.append(document.createTextNode(' x'));
    await Promise.resolve();
    const parent = /** @type {HTMLElement} */ (big.parentElement);
    const next = big.nextSibling;
    big.remove();
    await Promise.resolve();
    await Promise.resolve();
    void document.scrollingElement?.scrollHeight;
    parent.insertBefore(big, next);
  });
  await settled(page);
  const at = await page.evaluate(() => ({
    mode: document.querySelector('#main')?.getAttribute('data-view-mode'),
    gap: Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight),
  }));
  expect(at).toEqual({ mode: 'following', gap: expect.any(Number) });
  expect(at.gap).toBeLessThanOrEqual(2);
});

test('#297 in one frame: a change, then a finished reply drawn again shorter (item.patch to done), then the page growing, leaves the view following', async ({
  page,
}) => {
  const se = arrange.agentIn(app.rt, room);
  const long = Array.from({ length: 40 }, (_, i) => `Line ${i} of the streamed reply.`).join('\n\n');
  const it = arrange.post(app.rt, room, { kind: 'agent', sessionId: se?.id, handle: se?.handle ?? 'coder', text: long, status: 'streaming' });
  await page.goto(`${app.origin}/#/t/${room}`);
  await synced(page, app);
  await settled(page);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
  await page.evaluate(async (id) => {
    const { client } = await import('/app/js/client.mjs');
    const threadId = location.hash.split('/').at(-1);
    // No height held yet, as just after a new item (view-state.mjs release()): the hold would mask the shrink.
    /** @type {HTMLElement} */ (document.querySelector('#main')).style.removeProperty('margin-bottom');
    const items = [...document.querySelectorAll('#main > .item')];
    items.at(-2)?.append(document.createTextNode(' x'));
    await Promise.resolve();
    // The reply finishes and is drawn again, much shorter: the client’s own item.patch, as the stream delivers it.
    const patch = { status: 'done', text: 'Done.' };
    Object.assign(
      client.state.items[threadId].find((/** @type {any} */ x) => x.id === id),
      patch,
    );
    client.emit({ type: 'item.patch', data: { threadId, id, patch } });
    await Promise.resolve();
    await Promise.resolve();
    void document.scrollingElement?.scrollHeight;
    // Then the page grows again before the frame, as the next item lands.
    const grown = document.createElement('div');
    grown.style.height = '900px';
    document.querySelector(`#main > .item[data-key="${id}"]`)?.append(grown);
  }, it.id);
  await settled(page);
  const at = await page.evaluate(() => ({
    mode: document.querySelector('#main')?.getAttribute('data-view-mode'),
    gap: Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight),
  }));
  expect(at).toEqual({ mode: 'following', gap: expect.any(Number) });
  expect(at.gap).toBeLessThanOrEqual(2);
});
