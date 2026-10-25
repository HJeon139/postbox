// The review block’s Preview and Lines (#179):
// - a Markdown draft opens in Preview, with its Mermaid diagram and its math drawn, in light and dark themes, and
//   takes the transcript’s width at 1280 px;
// - Preview and Lines switch from the keyboard, focus stays on the choice, and the choice holds across a reload; Lines
//   draws the diagram and math whole too;
// - selecting text in Preview shows a Comment button beside it, which Tab reaches; Enter opens the comment box, and
//   adding the comment brings focus back to the text, which is marked; the agent gets its line, columns and quote;
// - a click on a diagram in Preview, which can’t be selected inside, opens Lines at its lines, with their comment box;
//   a click on text stays in Preview;
// - full screen opens and closes from the keyboard, with focus kept;
// - another agent’s comments (review_block, #133) show on their lines with its name, the review bar says who reviewed
//   it, and the block still waits on the person.
// Each test has a conversation of its own, where a scripted @drafter shows the draft. Moved from tools/check-review.mjs
// (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, focused, frames, startPostbox, synced } from './postbox.mjs';

// Line numbers matter: the selection below is on line 3, and the table row on line 10.
const DRAFT = [
  '# Release notes',
  '',
  'Make it **really bold** and see [the docs](https://example.com/docs) with `npm test`.',
  '',
  '- First item',
  '- Second item with $x^2$ inline',
  '',
  '| Name | Cost |',
  '|---|---|',
  '| Alpha | low price |',
  '',
  '```mermaid',
  'graph TD',
  '  A-->B',
  '```',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '- Steps:',
  '  ```sh',
  '  npm run check',
  '  ```',
].join('\n');
/** The draft, named for its conversation, so no other test’s draft can answer for it. */
const review = (threadId) => ({
  id: `notes-${threadId}`,
  type: 'review',
  version: 1,
  title: 'notes.md',
  fallback: 'The release notes',
  format: 'markdown',
  content: DRAFT,
});

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Every message Postbox sends the scripted agents. */
const calls = [];
let drafter;
let reader;
test.beforeAll(async () => {
  app = await startPostbox('review');
  // The agent: shows the review on cue, and revises it on cue.
  app.rt.adapters.register({
    name: 'mock',
    async deliver(session, message, ctx) {
      calls.push(message);
      const block = review(session.threadId);
      if (message.kind === 'user' && message.text.endsWith('review')) ctx.tools.show_block({ block });
      if (message.kind === 'user' && message.text.endsWith('revise'))
        ctx.tools.update_block({ block: { ...block, revision: 2, content: `${DRAFT}\n\nOne more line.`, previous: DRAFT } });
    },
  });
  drafter = app.rt.createPersona({ handle: 'drafter' });
  reader = app.rt.createPersona({ handle: 'reader' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

const idle = () => expect.poll(() => app.rt.turns.size, { message: 'the agents to finish' }).toBe(0);

/** A conversation of its own, with @drafter’s review in it, open in the page. Returns the block and its helpers. */
async function withReview(page, title) {
  const { rt, store } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [drafter.id, reader.id] });
  const blockId = review(thread.id).id;
  const itemOf = () => store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === blockId);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  rt.sendMessage(thread.id, { text: '@drafter review' });
  await expect.poll(() => !!itemOf(), { message: 'the review block' }).toBe(true);
  await idle();
  await synced(page, app);
  const block = page.locator(`[data-block-item="${itemOf().id}"]`);
  await expect(block).toBeVisible();
  const sessionOf = (handle) => rt.sessionsIn(thread.id).find((x) => x.handle === handle);
  return { thread, block, blockId, itemOf, sessionOf };
}

const viewRadio = (block, label) => block.locator('[aria-label="View"]').getByRole('radio', { name: label, exact: true });
/** What the block shows: its view, its lines, whether the diagram and math are drawn. */
const shown = (block) =>
  block.evaluate((b) => ({
    mode: b.querySelector('[aria-label="View"] [aria-checked="true"]')?.textContent ?? '',
    preview: !!b.querySelector('.rv-preview'),
    lines: b.querySelectorAll('.rv-line').length,
    diagram: !!b.querySelector('figure.diagram iframe[data-sized]'),
    math: b.querySelectorAll('.md-math.rendered').length,
  }));
/**
 * Waits for the block to show that view with its diagram and math drawn. A frame off screen isn’t drawn, so the
 * diagram is brought into view, as reading it would. Mermaid and KaTeX load on first use, a few megabytes.
 */
async function drawn(block, mode) {
  await expect
    .poll(
      async () => {
        await block.evaluate((b) => b.querySelector('figure.diagram, .rv-fig, figure.md-mermaid')?.scrollIntoView({ block: 'center' }));
        const s = await shown(block);
        return s.mode === mode && s.diagram && s.math >= 2;
      },
      { message: `${mode}, with its diagram and math drawn`, timeout: 20_000 },
    )
    .toBe(true);
  return shown(block);
}

/** Selects the first place a word is in Preview, then waits for the Comment button beside it, which moves as it settles. */
async function select(block, word) {
  await block.evaluate((b, w) => {
    const s = /** @type {Selection} */ (getSelection());
    const walk = document.createTreeWalker(/** @type {Node} */ (b.querySelector('.rv-preview .md')), NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode())
      if (/** @type {Text} */ (t).data.includes(w)) {
        const r = document.createRange();
        const k = /** @type {Text} */ (t).data.indexOf(w);
        r.setStart(t, k);
        r.setEnd(t, k + w.length);
        s.removeAllRanges();
        s.addRange(r);
        return;
      }
  }, word);
  const beside = () =>
    block.evaluate((b, w) => {
      const s = /** @type {Selection} */ (getSelection());
      const c = /** @type {HTMLElement} */ (b.querySelector('.rv-sel'));
      const r = s.rangeCount ? s.getRangeAt(0) : null;
      if (c.hidden || s.toString() !== w || !r || !c.previousElementSibling?.contains(r.endContainer)) return null;
      return { near: Math.abs(c.getBoundingClientRect().top - r.getBoundingClientRect().bottom) < 40, text: c.textContent };
    }, word);
  await expect.poll(beside, { message: 'the Comment button beside the selection' }).not.toBe(null);
  return beside();
}
/** Comments on the first place a word is in Preview, from the Comment button beside it. */
async function commentOn(page, block, word, text) {
  await select(block, word);
  await block.locator('.rv-sel').click();
  await expect(page.locator('textarea:focus')).toBeVisible();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Control+Enter');
  await expect(block.locator('.rv-thread', { hasText: text })).toBeAttached();
}

test('#179 the draft opens in Preview, with its diagram and math drawn, and takes the transcript’s width at 1280 px', async ({ page }) => {
  const { block } = await withReview(page, 'Preview');
  expect((await drawn(block, 'Preview')).preview).toBe(true);
  const width = await block.evaluate((b) => {
    const t = /** @type {Element} */ (document.querySelector('.transcript'));
    const s = getComputedStyle(t);
    return { block: b.getBoundingClientRect().width, room: t.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) };
  });
  expect(
    width.block > 760 && width.block >= width.room - 2,
    `the review takes the transcript’s width (${Math.round(width.block)} of ${Math.round(width.room)} px)`,
  ).toBe(true);
});

test('#179 selecting text shows a Comment button beside it, which Tab reaches; Enter opens the box; adding brings focus back, the text marked', async ({
  page,
}) => {
  const { block } = await withReview(page, 'Select');
  await drawn(block, 'Preview');
  // The person drags across “really bold”, which is also where Tab goes on from. The exact range is then set, so the
  // test doesn’t rest on where a pixel falls.
  const ends = await block.evaluate((b) => {
    const walk = document.createTreeWalker(/** @type {Node} */ (b.querySelector('.rv-preview .md')), NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode())
      if (/** @type {Text} */ (t).data.includes('really bold')) {
        const at = /** @type {Text} */ (t).data.indexOf('really bold');
        const rect = (k) => {
          const r = document.createRange();
          r.setStart(t, k);
          r.setEnd(t, k + 1);
          return r.getBoundingClientRect();
        };
        const a = rect(at);
        const z = rect(at + 10);
        return [
          { x: a.left + 1, y: a.top + a.height / 2 },
          { x: z.right - 1, y: z.top + z.height / 2 },
        ];
      }
    return null;
  });
  if (!ends) throw new Error('“really bold” isn’t in Preview');
  await page.mouse.move(ends[0].x, ends[0].y);
  await page.mouse.down();
  await page.mouse.move(ends[1].x, ends[1].y);
  await page.mouse.up();
  const button = await select(block, 'really bold');
  expect(button, 'a Comment button beside the selection').toEqual({ near: true, text: 'Comment' });
  await page.keyboard.press('Tab');
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
  await expect(block.locator('.rv-sel'), 'Tab reaches it, and a late selectionchange leaves it there').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Comment on “really bold”' }), 'Enter opens the comment box, with focus in it').toBeFocused();
  await page.keyboard.insertText('Too loud.');
  await page.keyboard.press('Control+Enter');
  await expect(block.locator('.rv-preview'), 'adding it brings focus back to Preview').toBeFocused();
  expect(await page.evaluate(() => getSelection()?.toString()), 'with the text selected again').toBe('really bold');
  expect(await page.evaluate(() => CSS.highlights.get('rv-quote')?.size ?? 0), 'the comment marks its text').toBeGreaterThanOrEqual(1);
  await expect(block.locator('.rv-preview .rv-thread q.rv-quote'), 'its thread quotes it').toHaveText('really bold');
});

test('#179 Lines opens from the keyboard, focus stays on it, draws the diagram and math whole, shows the comment on its line, and the choice holds across a reload', async ({
  page,
}) => {
  const { block } = await withReview(page, 'Lines');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'really bold', 'Too loud.');
  await viewRadio(block, 'Lines').focus();
  await page.keyboard.press('Enter');
  const lines = await drawn(block, 'Lines');
  expect(!lines.preview && lines.lines > 5, `Lines, not Preview (${JSON.stringify(lines)})`).toBe(true);
  await expect.poll(() => focused(page), { message: 'focus stays on Lines' }).toBe('radio: Lines');
  await expect(block.locator('.rv-line.marked .g-mark[data-line="3"]'), 'the comment on its line').toBeAttached();
  await expect(block.locator('.rv-doc .rv-thread q.rv-quote'), 'with its quote').toHaveText('really bold');
  await page.reload();
  await synced(page, app);
  await drawn(block, 'Lines');
  await viewRadio(block, 'Preview').click();
  await expect(viewRadio(block, 'Preview')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await synced(page, app);
  await drawn(block, 'Preview');
});

test('#179 a click on text stays in Preview, and one on the diagram opens Lines at its first line, with its comment box', async ({ page }) => {
  const { block } = await withReview(page, 'Clicks');
  await drawn(block, 'Preview');
  /** A point at the left of an element of the block, brought to the middle of the window. */
  const at = (locator) =>
    locator.evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + 4, y: r.top + r.height / 2 };
    });
  const text = await at(block.locator('.rv-preview td [data-sl]', { hasText: 'Alpha' }));
  await page.mouse.click(text.x, text.y);
  // Nothing should change here: a switch would draw Lines in the frames after the click.
  await frames(page);
  await frames(page);
  expect((await shown(block)).mode, 'a click on text stays in Preview').toBe('Preview');
  const diagram = await at(block.locator('.rv-fig .d-bar .label'));
  await page.mouse.click(diagram.x, diagram.y);
  await expect(page.getByRole('textbox', { name: 'Comment on line 12' }), 'the comment box at its first line').toBeFocused();
  expect((await shown(block)).mode).toBe('Lines');
});

test('#179 comments from Preview reach the agent with their line, columns and quote', async ({ page }) => {
  const { block, blockId } = await withReview(page, 'Submit');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  // And a word of a code block in a list item, whose lines sit past the item’s indent.
  await commentOn(page, block, 'run', 'Which script?');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments, { message: 'the agent gets the comments' })
    .toEqual([
      { line: 10, col: 11, endLine: 10, endCol: 13, quote: 'low', text: 'Say how low.' },
      { line: 23, col: 7, endLine: 23, endCol: 9, quote: 'run', text: 'Which script?' },
    ]);
});

test('#179 full screen opens from the keyboard, fills the window with focus on Exit full screen, and Escape brings it back', async ({ page }) => {
  const { block } = await withReview(page, 'Full screen');
  await block.getByRole('button', { name: 'Full screen', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(block.locator('.rv-box.rv-full')).toHaveAttribute('role', 'dialog');
  await expect.poll(() => focused(page)).toBe('button: Exit full screen');
  const fills = await block.locator('.rv-box').evaluate((b) => {
    const r = b.getBoundingClientRect();
    return r.width === innerWidth && r.height === innerHeight;
  });
  expect(fills, 'it fills the window').toBe(true);
  await page.keyboard.press('Escape');
  await expect(block.locator('.rv-box.rv-full')).toHaveCount(0);
  await expect(block.getByRole('button', { name: 'Full screen', exact: true }), 'focus back on Full screen').toBeFocused();
});

test('#133 another agent’s comments show on their lines with its name; the bar says who reviewed it, and it still waits on you', async ({ page }) => {
  const { rt, store } = app;
  const { thread, block, blockId, itemOf, sessionOf } = await withReview(page, 'Reviewed');
  // @drafter revises it in a turn of its own, so it needs you for revision 2.
  rt.sendMessage(thread.id, { text: '@drafter revise' });
  await expect.poll(() => itemOf().revision, { message: 'revision 2' }).toBe(2);
  await idle();
  await synced(page, app);
  await expect(block.locator('.answered-note')).toHaveCount(0);
  const needed = store.state.sessions[sessionOf('drafter').id].needs;
  expect(needed?.itemId, '@drafter needs you for revision 2').toBe(itemOf().id);
  const said = rt.toolsFor(sessionOf('reader').id).review_block({
    blockId,
    verdict: 'request_changes',
    comments: [
      { line: 1, text: 'A clearer title.' },
      { line: 10, col: 11, endLine: 10, endCol: 19, quote: 'low price', text: 'Give the number.' },
    ],
  });
  expect(said.ok, `@reader comments on @drafter’s review (${said.message})`).toBe(true);
  await idle();
  await synced(page, app);
  await viewRadio(block, 'Lines').click();
  const thread1 = block.locator('.rv-thread').filter({ has: page.locator('.meta b', { hasText: /^@reader$/ }) });
  await expect(thread1.filter({ hasText: 'Give the number.' }).locator('q.rv-quote'), 'its quote').toHaveText('low price');
  const first = await thread1
    .filter({ hasText: 'A clearer title.' })
    .evaluate((x) => /** @type {HTMLElement | null} */ (x.previousElementSibling?.querySelector('.g-mark'))?.dataset.line);
  expect(first, 'its comment on line 1, under it').toBe('1');
  await expect(block.locator('.review-bar .rv-reviewers')).toHaveText(' · 2 comments from @reader (Request changes)');
  await expect(block.getByRole('button', { name: 'Submit review', exact: true }), 'it still waits on you').toBeVisible();
  // Its event is a turn the person didn’t start, so it leaves what @drafter needs from you as it was.
  expect(
    calls.some((m) => m.event?.from === 'reader'),
    '@drafter hears it',
  ).toBe(true);
  expect(store.state.sessions[sessionOf('drafter').id].needs, 'what it needs from you doesn’t change').toEqual(needed);
});

test.describe('dark', () => {
  test.use({ colorScheme: 'dark' });

  test('#179 in the dark theme too, the diagram and math are drawn', async ({ page }) => {
    const { block } = await withReview(page, 'Dark');
    await drawn(block, 'Preview');
  });
});
