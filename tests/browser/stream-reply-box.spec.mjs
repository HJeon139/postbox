// #850: a streaming reply’s box, drawn from its kept blocks and what follows its cut (md-stream.mjs), reads as a whole
// render of the text so far after every event while it streams, not only once it ends: each block once, in order, a
// term not yet defined marked as such, and a reply whose text is replaced drawn from the new text.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('stream-reply-box');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const REPLY = [
  '### Findings',
  '',
  'The index uses [BM25](term:bm25) to rank pages, as @researcher noted.',
  '',
  '- one point',
  '- two points, with `code`',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '> a quote',
  '',
  '```js',
  'const x = 1;',
  '',
  'const y = 2;',
  '```',
  '',
  'Closing words of the reply, long enough to stream in several chunks.',
  '',
].join('\n');

/**
 * The box’s top-level blocks, and a whole render’s of the text, each as its tag and its text: equal when the box shows
 * every block once and in order. The caret isn’t a block.
 * @param {import('@playwright/test').Page} page @param {string} itemId @param {string} text
 */
const blocksOf = (page, itemId, text) =>
  page.evaluate(
    async ({ itemId, text }) => {
      const { renderMarkdown } = await import('/shared/markdown.mjs');
      const sig = (/** @type {Element} */ root) => [...root.children].filter((n) => !n.classList.contains('caret')).map((n) => `${n.tagName}:${n.textContent}`);
      const t = document.createElement('template');
      t.innerHTML = renderMarkdown(text, { streaming: true, mentions: ['researcher'] }); // lint-allow dom: the spec’s own render, to compare
      const box = document.querySelector(`#main > .item[data-key="${itemId}"] .md`);
      return { box: box ? sig(box) : null, whole: sig(/** @type {any} */ (t.content)) };
    },
    { itemId, text },
  );

test('#850 a streaming reply’s box reads as a whole render after every chunk, marks undefined terms, and redraws replaced text', async ({ page }) => {
  const { rt, store } = app;
  const t = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title: 'Streaming box',
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const [se] = arrange.sessionsIn(rt, t.id);
  const it = arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: '', status: 'streaming' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const textNow = () => /** @type {any} */ (store.items(t.id).find((x) => x.id === it.id)).text;
  for (let at = 0; at < REPLY.length; at += 23) {
    store.emit('item.text', { threadId: t.id, id: it.id, text: REPLY.slice(at, at + 23) });
    await frames(page);
    const text = textNow();
    await expect
      .poll(async () => (await blocksOf(page, it.id, text)).box, { message: `the box at ${text.length} characters` })
      .toEqual((await blocksOf(page, it.id, text)).whole);
  }
  const box = page.locator(`#main > .item[data-key="${it.id}"] .md`);
  await expect(box.locator('.caret'), 'still streaming').toHaveCount(1);
  await expect(box.locator('.term.undef'), 'a term not defined yet is marked while it streams').toHaveCount(1);
  // The text replaced from the start, as a replay does: drawn from the new text, nothing of the old kept.
  arrange.setItem(rt, t.id, it.id, { text: 'Replaced from the start.\n\nNew words follow it.\n\n' });
  await frames(page);
  await expect.poll(async () => (await blocksOf(page, it.id, textNow())).box).toEqual((await blocksOf(page, it.id, textNow())).whole);
  await expect(box).not.toContainText('Findings');
});

test('#850 writeStreaming starts again from the top when the text no longer extends what it kept, or how it draws changes', async ({ page }) => {
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  const got = await page.evaluate(async () => {
    const { writeStreaming } = await import('/app/js/md-stream.mjs');
    const { renderMarkdown } = await import('/shared/markdown.mjs');
    const box = document.createElement('div');
    const sig = (/** @type {Element} */ root) => [...root.children].map((n) => `${n.tagName}:${n.textContent}`).join('|');
    const whole = (/** @type {string} */ text) => {
      const t = document.createElement('template');
      t.innerHTML = renderMarkdown(text, {}); // lint-allow dom: the spec’s own render, to compare
      return sig(/** @type {any} */ (t.content));
    };
    const a = 'First block.\n\nSecond block.\n\nThird block.\n\nFourth';
    writeStreaming(box, a, {}, 'k');
    const b = 'Another start.\n\nOther words.\n\nAnd more';
    writeStreaming(box, b, {}, 'k');
    const replaced = sig(box) === whole(b);
    // The same text drawn another way (its options changed): the whole box is handed back to be marked again.
    const back = writeStreaming(box, `${b} words`, {}, 'k2');
    return { replaced, wholeBack: back.length === 1 && back[0] === box };
  });
  expect(got.replaced, 'text that doesn’t extend what was kept is drawn from the top').toBe(true);
  expect(got.wholeBack, 'drawn another way, the whole box is handed back for its marks').toBe(true);
});
