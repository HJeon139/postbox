// Closing blocks that ask (#106):
// - the person dismisses an open choice from the keyboard, with the button after its own answer buttons: it reads
//   “Dismissed by you”, its Dismiss button goes, the agent hears “dismiss”, and its agent stops needing them;
// - the agent withdraws a choice it asked: it reads “Withdrawn by @drafter” with the reason, and can’t be answered;
// - the agent records an outcome on an approved review: it shows under the answer, and the review stays answered.
// The image block (#180): the demo’s title page, from Postbox’s own media, loads with the page opened at 127.0.0.1 and
// at localhost, and an image that fails says so, in place of a broken image; the same holds for a review’s Markdown
// images (#218), and one that failed is commented on whole (#179). The code block (#41): its header shows the
// filename, and its code is highlighted, line numbers intact.
// Each test has a conversation of its own, where a scripted @drafter shows the blocks. Moved from
// tools/check-blocks.mjs (#303).

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const choice = (id, title) => ({
  id,
  type: 'choice',
  version: 1,
  title,
  fallback: title,
  options: [
    { id: 'issue', label: 'A new issue' },
    { id: 'comment', label: 'A comment' },
  ],
});
const review = { id: 'draft', type: 'review', version: 1, title: 'issue.md', fallback: 'The draft issue', format: 'markdown', content: '# Draft' };
// The block from #41’s report ({ title: "The schema", filename: "schema.ts", language: "ts" }), with a comment that
// spans two lines, and one with a filename and no title.
const TS = '/* Where a passage sits\n   in its book. */\nexport function span(p) {\n  return { start: p.start, end: 18342, unit: "char" };\n}';
const PY = '# Offsets, not pages\ndef span(p):\n    return (p.start, 18342)';
const codeBlock = (id, extra) => ({ id, type: 'code', version: 1, fallback: 'The passage offsets', ...extra });

/** What @drafter shows, by the message it’s sent. */
const scripts = {
  ask: (ctx) => ctx.tools.show_block({ block: choice('where', 'Where should I report this?') }),
  stale: (ctx) => ctx.tools.show_block({ block: choice('stale', 'Which tracker?') }),
  review: (ctx) => ctx.tools.show_block({ block: review }),
  images: (ctx) => {
    // The demo’s title page, as tools/demo.mjs shows it, and one that isn’t there.
    const media = (name) => `${process.env.POSTBOX_ORIGIN}/media/${name}`;
    const image = (id, name) => ({ id, type: 'image', version: 1, fallback: 'The title page', src: media(name), alt: `The ${id}` });
    ctx.tools.show_block({ block: { ...image('title-page', 'middlemarch-title.svg'), caption: 'Served by Postbox, an allowed origin.' } });
    ctx.tools.show_block({ block: image('missing-page', 'not-there.svg') });
    const content = `# Pictures\n\n![The title page](${media('middlemarch-title.svg')})\n\n![A missing page](${media('not-there.svg')})\n\n![A page from elsewhere](https://example.com/elsewhere.png)`;
    ctx.tools.show_block({ block: { ...review, id: 'pictures', title: 'pictures.md', fallback: 'A draft with pictures', content } });
  },
  code: (ctx) => {
    ctx.tools.show_block({ block: codeBlock('schema', { title: 'The schema', filename: 'schema.ts', language: 'ts', code: TS }) });
    ctx.tools.show_block({ block: codeBlock('offsets', { filename: 'offsets.py', language: 'python', code: PY }) });
  },
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Every message Postbox sends @drafter. */
const calls = [];
let drafter;
test.beforeAll(async () => {
  app = await startPostbox('blocks');
  app.rt.adapters.register({
    name: 'mock',
    async deliver(_session, message, ctx) {
      calls.push(message);
      if (message.kind === 'user') await scripts[message.text]?.(ctx);
    },
  });
  drafter = app.rt.createPersona({ handle: 'drafter' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/**
 * A conversation of its own, where @drafter has shown what that message asks for, open in the page at that origin.
 * block(id) is a block of it on the page.
 */
async function conversation(page, title, ask, origin = app.origin) {
  const { rt } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [drafter.id] });
  const se = rt.sessionsIn(thread.id)[0];
  const itemOf = (id) => rt.store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === id);
  rt.sendMessage(thread.id, { text: ask });
  await expect.poll(() => rt.turns.size === 0 && rt.store.items(thread.id).some((i) => i.kind === 'block'), { message: `@drafter to show ${ask}` }).toBe(true);
  await page.goto(`${origin}/#/t/${thread.id}`);
  await synced(page, app);
  const block = (id) => page.locator(`[data-block-item="${itemOf(id)?.id}"]`);
  return { thread, se, itemOf, block, tools: rt.toolsFor(se.id) };
}
/** What a block shows: its closed note, whether it can still be dismissed or answered, its outcome and your answer. */
const shown = (block) =>
  block.evaluate((b) => ({
    note: b.querySelector('.closed-note')?.textContent ?? '',
    dismiss: !!b.querySelector('button.dismiss'),
    answered: b.classList.contains('answered'),
    enabled: [...b.querySelectorAll('.chip, button')].filter((x) => !(/** @type {HTMLButtonElement} */ (x).disabled) && !x.closest('.block-head')).length,
    outcome: b.querySelector('.outcome')?.textContent ?? '',
    voice: b.querySelector('.block-foot .answered-note')?.textContent ?? '',
  }));

// ── Closing blocks that ask (#106) ──────────────────────────────────────────────────────

test('#106 the person dismisses an open choice by keyboard, after its Send: the agent hears it, and stops needing you', async ({ page }) => {
  const { store } = app;
  const { se, itemOf, block } = await conversation(page, 'Dismissed', 'ask');
  expect(store.state.sessions[se.id].needs?.itemId, 'the open choice makes its agent need you').toBe(itemOf('where').id);
  // After the block’s own answer, so going to the block (⌃J, needs-you) and Tab reach the answer first.
  const order = await block('where')
    .locator('button:not([disabled])')
    .evaluateAll((bs) => bs.map((b) => b.textContent).slice(-2));
  expect(order, 'Dismiss, after Send choice').toEqual(['Send choice', 'Dismiss']);
  await block('where').locator('button.dismiss').focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => calls.find((m) => m.kind === 'event' && m.event.blockId === 'where')?.event.action, { message: 'the agent hears “dismiss”' })
    .toBe('dismiss');
  expect(store.state.sessions[se.id].needs, 'its agent no longer needs you').toBe(null);
  await expect(block('where').locator('.closed-note')).toHaveText(/^Dismissed by you at \d\d:\d\d$/);
  const s = await shown(block('where'));
  expect([s.dismiss, s.answered, s.enabled], 'it’s closed: no Dismiss, and nothing to answer').toEqual([false, true, 0]);
});

test('#106 the agent withdraws a choice it asked: it reads by whom and why, and can’t be answered', async ({ page }) => {
  const { store } = app;
  const { se, block, tools } = await conversation(page, 'Withdrawn', 'stale');
  await expect(block('stale').locator('button.dismiss')).toBeVisible();
  const r = tools.update_block({ block: { id: 'stale', withdraw: 'You answered in chat.' } });
  expect(r.ok, `the agent withdraws it (${r.message})`).toBe(true);
  expect(store.state.sessions[se.id].needs, 'its agent no longer needs you once it’s withdrawn').toBe(null);
  await expect(block('stale').locator('.closed-note')).toHaveText(/^Withdrawn by @drafter at \d\d:\d\d: You answered in chat\.$/);
  const s = await shown(block('stale'));
  expect([s.dismiss, s.answered, s.enabled], 'it’s closed: no Dismiss, and nothing to answer').toEqual([false, true, 0]);
});

test('#106 the agent records an outcome on an approved review: it shows under the answer, and the review stays answered', async ({ page }) => {
  const { rt } = app;
  const { thread, itemOf, block, tools } = await conversation(page, 'Outcome', 'review');
  rt.act(thread.id, itemOf('draft').id, 'submit', { verdict: 'approve', comments: [] }, 1);
  await expect.poll(() => !!itemOf('draft').answer?.read, { message: 'the answer read' }).toBe(true);
  const o = tools.update_block({ block: { ...review, outcome: 'Filed as #105.' } });
  expect(o.ok, `the agent records an outcome (${o.message})`).toBe(true);
  await expect(block('draft').locator('.outcome')).toHaveText('Filed as #105.');
  const s = await shown(block('draft'));
  expect(s.voice).toMatch(/^Submitted review: approve/i);
  expect(s.dismiss).toBe(false);
});

// ── Images (#180, #218) ─────────────────────────────────────────────────────────────────

/**
 * The errors an image test causes on purpose: the missing image’s 404s, and the policy refusing the one from elsewhere.
 * Each comes again every time a review draws its Markdown, which a switch to Lines does, so they’re let through for the
 * test, not counted.
 */
function expectImageErrors(page) {
  allowPageError(page, /status of 404/, { times: Number.POSITIVE_INFINITY });
  allowPageError(page, /example\.com\/elsewhere\.png/, { times: Number.POSITIVE_INFINITY });
}

for (const host of ['127.0.0.1', 'localhost'])
  test(`#180 #218 at ${host}, the demo’s title page loads, in an image block and a review’s Markdown, and an image that fails says so`, async ({ page }) => {
    expectImageErrors(page);
    const { block } = await conversation(page, `Images at ${host}`, 'images', app.origin.replace('127.0.0.1', host));
    const loaded = (img) => img.evaluate((i) => /** @type {HTMLImageElement} */ (i).complete && /** @type {HTMLImageElement} */ (i).naturalWidth > 0);
    await block('title-page').scrollIntoViewIfNeeded();
    await expect.poll(() => loaded(block('title-page').locator('img')), { message: 'the title page loads' }).toBe(true);
    await block('missing-page').scrollIntoViewIfNeeded();
    await expect(block('missing-page').locator('.img-failed')).toHaveText('This image couldn’t load. It shows: The missing-page');
    await expect(block('missing-page').locator('img'), 'no broken image').toHaveCount(0);
    // A review’s Markdown images: Postbox’s own loads, and one that fails says so in its place (#218).
    await block('pictures').scrollIntoViewIfNeeded();
    const md = block('pictures').locator('img.md-img');
    await expect.poll(() => loaded(md), { message: 'a review’s Markdown image loads' }).toBe(true);
    await expect(md).toHaveAttribute('alt', 'The title page');
    // One that isn’t there, and one from an origin the page’s policy doesn’t allow (server/index.mjs, img-src).
    await expect(block('pictures').locator('.img-failed')).toHaveText([
      'This image couldn’t load. It shows: A missing page',
      'This image couldn’t load. It shows: A page from elsewhere',
    ]);
  });

test('#179 a click on a review’s image that failed opens Lines at its line, with its comment box', async ({ page }) => {
  expectImageErrors(page);
  const { block } = await conversation(page, 'Failed image', 'images');
  const failed = block('pictures').locator('.img-failed').first();
  await failed.scrollIntoViewIfNeeded();
  await expect(failed).toBeVisible();
  const box = await failed.boundingBox();
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await expect(page.getByRole('textbox', { name: 'Comment on line 5' })).toBeFocused();
});

// ── The code block (#41) ────────────────────────────────────────────────────────────────

test('#41 a code block’s header shows its filename, and its code is highlighted with its line numbers intact', async ({ page }) => {
  const { block } = await conversation(page, 'Code', 'code');
  await expect(block('offsets').locator('pre')).toBeVisible();
  const code = (id) =>
    block(id).evaluate((b) => {
      const pre = /** @type {Element} */ (b.querySelector('pre'));
      const of = (c) => [...pre.querySelectorAll(c)].map((n) => n.textContent).join();
      const label = b.getAttribute('aria-labelledby');
      return {
        title: b.querySelector('.block-head .title')?.textContent,
        file: /** @type {HTMLElement | null} */ (b.querySelector('.block-head .code-file')?.offsetWidth ?? 0) > 0,
        name: label && document.getElementById(label)?.textContent,
        text: [...pre.childNodes]
          .filter((n) => !(/** @type {Element} */ (n).classList?.contains('ln')))
          .map((n) => n.textContent)
          .join(''),
        lines: pre.querySelectorAll('.ln').length,
        kw: of('.kw'),
        str: of('.str'),
        num: of('.num-t'),
        fn: of('.fn'),
        com: of('.com'),
      };
    });
  const ts = await code('schema');
  expect([ts.title, ts.file], 'the header shows the title and the filename').toEqual(['The schema schema.ts', true]);
  expect(ts.name, 'the block’s accessible name carries the filename').toBe('The schema schema.ts');
  expect([ts.text, ts.lines], 'the code reads as sent, with a number on each of its 5 lines').toEqual([TS, 5]);
  expect({ kw: ts.kw, str: ts.str, num: ts.num, fn: ts.fn, com: ts.com }, 'TypeScript is highlighted').toEqual({
    kw: 'export,function,return',
    str: '"char"',
    num: '18342',
    fn: 'span',
    com: '/* Where a passage sits,   in its book. */',
  });
  const py = await code('offsets');
  expect([py.title, py.file], 'with no title, the filename is the title').toEqual(['offsets.py', true]);
  expect({ com: py.com, kw: py.kw, fn: py.fn }, 'Python is highlighted').toEqual({ com: '# Offsets, not pages', kw: 'def,return', fn: 'span' });
});
