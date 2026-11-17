// #850: while a reply streams, each frame rendered its whole Markdown again and the page parsed all of it, so the work
// a frame grew with the reply. Now the blocks it has closed render once, and each frame renders and parses only what
// follows them (md-stream.mjs). The spec counts the HTML the page parses a frame, with the reply at its start and
// after it has grown ten times, and checks the reply reads the same as a whole render once it ends.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('stream-reply-cost');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const PARA = (n) => `Paragraph ${n} reads each **book** once, then ranks the pages by how often a \`term\` appears.\n\n`;
const paras = (from, to) => Array.from({ length: to - from }, (_, k) => PARA(from + k)).join('');

/** Counts the HTML the page parses through templates, as Markdown is drawn, from now on. */
const countParsing = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.parsed = 0;
    const d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML'));
    Object.defineProperty(HTMLTemplateElement.prototype, 'innerHTML', {
      configurable: true,
      get() {
        return d.get?.call(this);
      },
      set(v) {
        w.parsed += String(v).length;
        d.set?.call(this, v);
      },
    });
  });

test('#850 a streaming reply’s work a frame stays flat as the reply grows ten times', async ({ page }) => {
  const { rt, store } = app;
  const t = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title: 'A long reply',
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const [se] = arrange.sessionsIn(rt, t.id);
  const it = arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: paras(0, 20), status: 'streaming' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const box = page.locator(`#main > .item[data-key="${it.id}"] .md`);
  await expect(box).toContainText('Paragraph 19');
  await countParsing(page);
  /** The HTML parsed a frame, over ten frames that each add a word to the reply’s last paragraph. */
  const perFrame = async (/** @type {string} */ tag) => {
    let total = 0;
    for (let k = 0; k < 10; k++) {
      await page.evaluate(() => {
        /** @type {any} */ (window).parsed = 0;
      });
      store.emit('item.text', { threadId: t.id, id: it.id, text: `${tag}${k} ` });
      await expect(box).toContainText(`${tag}${k}`);
      await frames(page);
      total += await page.evaluate(() => /** @type {any} */ (window).parsed);
    }
    return total / 10;
  };
  const start = await perFrame('early');
  store.emit('item.text', { threadId: t.id, id: it.id, text: `\n\n${paras(20, 200)}` });
  await expect(box).toContainText('Paragraph 199');
  const grown = await perFrame('late');
  expect(start, 'the page parses the reply as it streams').toBeGreaterThan(0);
  expect(grown, `HTML parsed a frame: ${start} characters at 20 paragraphs, ${grown} at 200`).toBeLessThan(start * 2);
  // Ended, it reads as rendering it whole does.
  arrange.setItem(rt, t.id, it.id, { status: 'done' });
  await expect(page.locator(`#main > .item[data-key="${it.id}"] .caret`)).toHaveCount(0);
  const whole = await page.evaluate(
    async (text) => {
      const { renderMarkdown } = await import('/shared/markdown.mjs');
      const t = document.createElement('div');
      t.innerHTML = renderMarkdown(text, { mentions: [] }); // lint-allow dom: the spec’s own render, to compare text
      return t.textContent;
    },
    store.items(t.id).find((x) => x.id === it.id).text,
  );
  expect(await box.evaluate((n) => n.textContent)).toBe(whole);
  // The 200 paragraphs, and the words each run of frames added, which start a paragraph after a blank line.
  expect(await box.locator(':scope > p').count(), 'every paragraph once').toBe(202);
});
