// An item drawn again (thread.mjs’s rerender: a patch, an exit code, an edit) is a new node. Under
// `content-visibility: auto` the browser treats a new node as skipped until a frame decides it’s on screen, and a
// skipped item’s innerText is empty: a read in that gap (copy as text, an assistive tool, a spec) got nothing (#1246).
// A redraw keeps what the old node was: drawn stays drawn, and skipped stays skipped, so an item off screen isn’t laid
// out for it.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox } from './postbox.mjs';
import { open as openIn, room as roomIn } from './view-read-fixture.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-redraw');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/**
 * Patches item id through the client, as an event from the server does, and reads the item’s new node in the same
 * task: its innerText, its textContent, and whether its content is skipped.
 * @param {any} page @param {string} threadId @param {string} id @param {string} text
 */
const patchAndRead = (page, threadId, id, text) =>
  page.evaluate(
    async ({ threadId, id, text }) => {
      const { client } = await import('/app/js/client.mjs');
      const { apply } = await import('/shared/state.mjs');
      const data = { threadId, id, patch: { text } };
      apply(client.state, 'item.patch', data);
      client.emit({ type: 'item.patch', data });
      const n = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript > [data-key="${CSS.escape(id)}"]`));
      const first = /** @type {Element} */ (n.firstElementChild);
      // biome-ignore lint/performance/useDomNodeTextContent: the words as copy and a reader get them, which a skipped item doesn’t give
      return { inner: n.innerText, text: n.textContent ?? '', skipped: !first.checkVisibility({ contentVisibilityAuto: true }) };
    },
    { threadId, id, text },
  );

test('#1246: an item on screen drawn again has its words at once, and one off screen stays skipped', async ({ page }) => {
  const { t } = roomIn(app, 'Redrawn items');
  await openIn(app, page, t);
  const items = app.store.state.items[t.id];
  const near = items.at(-2);
  const far = items[1];
  expect(await page.locator(`[data-key="${near.id}"]`).isVisible(), 'the item near the end is on screen').toBe(true);

  const onScreen = await patchAndRead(page, t.id, near.id, 'Drawn again, on screen.');
  expect.soft(onScreen.text, 'the new node holds the words').toContain('Drawn again, on screen.');
  expect.soft(onScreen.skipped, 'the item on screen isn’t skipped once drawn again').toBe(false);
  expect.soft(onScreen.inner, 'its innerText has them in the same task').toContain('Drawn again, on screen.');

  const offScreen = await patchAndRead(page, t.id, far.id, 'Drawn again, off screen.');
  expect.soft(offScreen.text, 'the new node off screen holds the words').toContain('Drawn again, off screen.');
  expect.soft(offScreen.skipped, 'an item off screen drawn again stays skipped, not laid out').toBe(true);
});

// The newest item, appended while the view follows, is drawn by drawNewest until it has painted (view-skip.mjs), and
// the browser reports nothing about it while it’s held. A patch in that time, as a command’s exit code can be, drew it
// again with nothing to say it had been drawn (#1246, commands.spec.mjs). Appended and patched in one task here.
test('#1246: the newest item, patched while it’s held drawn, has its words at once', async ({ page }) => {
  const { t } = roomIn(app, 'Redrawn newest');
  await openIn(app, page, t);
  const got = await page.evaluate(async (threadId) => {
    const { client } = await import('/app/js/client.mjs');
    const { apply } = await import('/shared/state.mjs');
    const send = (/** @type {string} */ type, /** @type {any} */ data) => {
      apply(client.state, type, data);
      client.emit({ type, data });
    };
    const item = { id: 'it_newest_1246', kind: 'user', text: 'Running a command.', at: Date.now() };
    send('item.add', { threadId, item });
    send('item.patch', { threadId, id: item.id, patch: { text: 'The command finished.' } });
    const n = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript > [data-key="${item.id}"]`));
    // biome-ignore lint/performance/useDomNodeTextContent: the words as copy and a reader get them, which a skipped item doesn’t give
    return { inner: n.innerText, skipped: !(/** @type {Element} */ (n.firstElementChild).checkVisibility({ contentVisibilityAuto: true })) };
  }, t.id);
  expect.soft(got.skipped, 'the newest item drawn again isn’t skipped').toBe(false);
  expect.soft(got.inner, 'its innerText has the patched words in the same task').toContain('The command finished.');
});
