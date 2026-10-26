// What the review specs share (review, review-comments): a Postbox whose scripted @drafter shows a Markdown draft
// with a diagram and math on cue, and revises it on cue, and the review block as a person sees it.

import { expect } from '@playwright/test';
import { startPostbox, synced } from './postbox.mjs';

// Line numbers matter: the selection below is on line 3, and the table row on line 10.
export const DRAFT = [
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
export const review = (threadId) => ({
  id: `notes-${threadId}`,
  type: 'review',
  version: 1,
  title: 'notes.md',
  fallback: 'The release notes',
  format: 'markdown',
  content: DRAFT,
});

/**
 * Starts a spec’s Postbox with @drafter and @reader. calls holds every message Postbox sends them; withReview opens a
 * conversation of its own with @drafter’s review in it, and returns the block and its helpers.
 * @param {string} name
 */
export async function reviewRoom(name) {
  const app = await startPostbox(name);
  /** @type {any[]} */
  const calls = [];
  // The agent: shows the review on cue, and revises it on cue.
  app.rt.adapters.register({
    name: 'mock',
    async deliver(session, message, ctx) {
      calls.push(message);
      const block = review(session.threadId);
      if (message.kind === 'user' && message.text.endsWith('review')) ctx.tools.show_block({ block });
      if (message.kind === 'user' && message.text.endsWith('revise'))
        ctx.tools.update_block({ block: { ...block, revision: 2, content: `${DRAFT}\n\nOne more line.`, previous: DRAFT } });
      // As the UAT’s agent revised (#248): with previous, and no revision of its own, which is optional.
      const again = /revise (\d+)$/.exec(message.kind === 'user' ? message.text : '');
      if (message.kind === 'user' && message.text.endsWith('file')) ctx.tools.update_block({ block: { id: block.id, outcome: 'Filed as #418.' } });
      if (again) ctx.tools.update_block({ block: { ...block, content: `${DRAFT}\n\nRevision ${again[1]}.`, previous: DRAFT } });
    },
  });
  const drafter = app.rt.createPersona({ handle: 'drafter' });
  const reader = app.rt.createPersona({ handle: 'reader' });
  const idle = () => expect.poll(() => app.rt.turns.size, { message: 'the agents to finish' }).toBe(0);
  /** @param {import('@playwright/test').Page} page  @param {string} title */
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
  return { app, calls, idle, withReview };
}

export const viewRadio = (block, label) => block.locator('[aria-label="View"]').getByRole('radio', { name: label, exact: true });
/** What the block shows: its view, its lines, whether the diagram and math are drawn. */
export const shown = (block) =>
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
export async function drawn(block, mode) {
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
export async function select(block, word) {
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
export async function commentOn(page, block, word, text) {
  await select(block, word);
  await block.locator('.rv-sel').click();
  await expect(page.locator('textarea:focus')).toBeVisible();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Control+Enter');
  await expect(block.locator('.rv-thread', { hasText: text })).toBeAttached();
}
