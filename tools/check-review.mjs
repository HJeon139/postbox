// A headless Chrome check of the review block’s Preview and Lines (#179):
//   • a Markdown draft opens in Preview, with its Mermaid diagram and its math drawn, in light and dark themes, and
//     takes the transcript’s width at 1280 px;
//   • Preview and Lines switch from the keyboard, focus stays on the choice, and the choice holds across a reload;
//     Lines draws the diagram and math whole too;
//   • selecting text in Preview shows a Comment button beside it, which Tab reaches; Enter opens the comment box, and
//     adding the comment brings focus back to the text, which is marked; the agent gets its line, columns and quote;
//   • a click on a diagram in Preview, which can’t be selected inside, opens Lines at its lines, with their comment
//     box; a click on text stays in Preview;
//   • full screen opens and closes from the keyboard, with focus kept;
//   • another agent’s comments (review_block, #133) show on their lines with its name, the review bar says who
//     reviewed it, and the block still waits on the person.
//
//   node tools/check-review.mjs
//
// It runs its own Postbox, with a fresh data folder and a scripted agent, and its own headless Chrome.
// PB_PORT and PB_CHROME_PORT move them, so sessions working in parallel don’t collide.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT: CHROME } = await ports(5150, 10450);

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
const review = { id: 'notes', type: 'review', version: 1, title: 'notes.md', fallback: 'The release notes', format: 'markdown', content: DRAFT };

/** The agent: shows the review on cue, and records every message Postbox sends it. */
const calls = [];
const agent = {
  name: 'mock',
  async deliver(_session, message, ctx) {
    calls.push(message);
    if (message.kind === 'user' && message.text.endsWith('review')) ctx.tools.show_block({ block: review });
    if (message.kind === 'user' && message.text.endsWith('revise'))
      ctx.tools.update_block({ block: { ...review, revision: 2, content: `${DRAFT}\n\nOne more line.`, previous: DRAFT } });
  },
};

const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-review-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
app.rt.adapters.register(agent);
const page = await launch({ port: CHROME });
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  return null;
};
async function press(key, code, keyCode, { text, modifiers = 0 } = {}) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const ENTER = ['Enter', 'Enter', 13, { text: '\r' }];
const TAB = ['Tab', 'Tab', 9];
/** Escape, then the page back in front: Escape hides a headless page (Chrome’s, on macOS), as check-commands.mjs says. */
async function pressEscape() {
  await press('Escape', 'Escape', 27);
  await page.send('Page.bringToFront');
}

try {
  const { rt, store } = app;
  const project = Object.values(rt.s.projects)[0];
  const persona = rt.createPersona({ handle: 'drafter' });
  const reader = rt.createPersona({ handle: 'reader' });
  const thread = rt.createThread({ projectId: project.id, title: 'Review checks', personaIds: [persona.id, reader.id] });
  const sessionOf = (handle) => rt.sessionsIn(thread.id).find((x) => x.handle === handle);
  const itemOf = (id) => rt.store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === id);
  let id = '';
  const block = () => `document.querySelector('[data-block-item="${id}"]')`;
  const radio = (group, label) => `[...${block()}.querySelectorAll('[aria-label="${group}"] [role="radio"]')].find((x) => x.textContent === '${label}')`;
  /** Selects the first word in Preview, then waits for the Comment button beside it, which moves as the page hears it. */
  const select = async (word) => {
    await page.evaluate(`(() => { const word = ${JSON.stringify(word)}, s = getSelection(), w = document.createTreeWalker(${block()}.querySelector('.rv-preview .md'), NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) if (t.data.includes(word)) { const r = document.createRange(), k = t.data.indexOf(word);
        r.setStart(t, k); r.setEnd(t, k + word.length); s.removeAllRanges(); s.addRange(r); return; } })()`);
    const beside = `(() => { const word = ${JSON.stringify(word)}, s = getSelection(), c = ${block()}.querySelector('.rv-sel'), r = s.rangeCount && s.getRangeAt(0);
      return !c.hidden && s.toString() === word && !!c.previousElementSibling?.contains(r.endContainer)
        && { near: Math.abs(c.getBoundingClientRect().top - r.getBoundingClientRect().bottom) < 40, text: c.textContent }; })()`;
    return until(() => page.evaluate(beside));
  };
  /** Comments on the first word in Preview, from the Comment button beside it. */
  const commentOn = async (word, text) => {
    await select(word);
    await page.evaluate(`${block()}.querySelector('.rv-sel').click()`);
    await until(() => page.evaluate(`document.activeElement?.tagName === 'TEXTAREA' && (document.activeElement.value = ${JSON.stringify(text)})`));
    await press('Enter', 'Enter', 13, { modifiers: 2 });
  };
  const shown = () =>
    page.evaluate(`(() => { const b = ${block()}; return b && {
      mode: b.querySelector('[aria-label="View"] [aria-checked="true"]')?.textContent ?? '',
      preview: !!b.querySelector('.rv-preview'), lines: b.querySelectorAll('.rv-line').length,
      diagram: !!b.querySelector('figure.diagram iframe[data-sized]'), math: b.querySelectorAll('.md-math.rendered').length,
      focus: document.activeElement === document.body ? 'body' : document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.slice(0, 40) || '' }; })()`);
  // A frame off screen isn’t drawn (Chrome throttles it), so the diagram is brought into view, as reading it would.
  // Mermaid and KaTeX load on first use, a few megabytes, which a busy runner can take a while over.
  const drawn = (mode) =>
    until(async () => {
      await page.evaluate(`${block()}?.querySelector('figure.diagram, .rv-fig, figure.md-mermaid')?.scrollIntoView({ block: 'center' })`);
      const s = await shown();
      return s?.mode === mode && s.diagram && s.math >= 2 && s;
    }, 20000);

  await page.size(1280, 900);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  rt.sendMessage(thread.id, { text: '@drafter review' });
  await until(() => itemOf('notes') && !rt.turns.size);
  id = itemOf('notes').id;
  await page.synced(store.state.seq);
  await page.waitFor(`${block()}`, { label: 'the review block' });

  // ── Preview, drawn, and wide ──
  const opened = await drawn('Preview');
  check(!!opened?.preview, `the draft opens in Preview, with its diagram and math drawn (${JSON.stringify(opened)})`);
  const width = await page.evaluate(
    `(() => { const t = document.querySelector('.transcript'); const s = getComputedStyle(t); return { block: ${block()}.getBoundingClientRect().width, room: t.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) }; })()`,
  );
  check(
    width.block > 760 && width.block >= width.room - 2,
    `at 1280 px the review takes the transcript’s width (${Math.round(width.block)} of ${Math.round(width.room)} px)`,
  );

  // ── Select text: a Comment button beside it, reached by Tab ──
  // The person drags across “really bold”, which is also where Tab goes on from. The exact range is then set, so
  // the check doesn’t rest on where a pixel falls.
  const ends = await page.evaluate(`(() => {
    const md = ${block()}.querySelector('.rv-preview .md');
    const walk = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) if (t.data.includes('really bold')) {
      const at = t.data.indexOf('really bold');
      const rect = (k) => { const r = document.createRange(); r.setStart(t, k); r.setEnd(t, k + 1); return r.getBoundingClientRect(); };
      const a = rect(at), z = rect(at + 10);
      return [{ x: a.left + 1, y: a.top + a.height / 2 }, { x: z.right - 1, y: z.top + z.height / 2 }];
    }
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...ends[0], button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...ends[1], button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...ends[1], button: 'left', clickCount: 1 });
  const button = await select('really bold');
  check(button?.text === 'Comment' && button.near, `selecting text shows a Comment button beside it (${JSON.stringify(button)})`);
  await press(...TAB);
  const tabbed = await page.evaluate(`document.dispatchEvent(new Event('selectionchange')), document.activeElement?.classList.contains('rv-sel')`);
  check(tabbed, 'Tab from the selection reaches the Comment button, and a late selectionchange leaves it there');
  await press(...ENTER);
  const box = await until(() => page.evaluate(`document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.getAttribute('aria-label')`));
  check(box === 'Comment on “really bold”', `Enter opens the comment box, with focus in it (${box})`);
  await page.evaluate(`document.activeElement.value = 'Too loud.'`);
  await press('Enter', 'Enter', 13, { modifiers: 2 });
  const back = await until(() =>
    page.evaluate(`(() => { const p = ${block()}.querySelector('.rv-preview'); return document.activeElement === p && getSelection().toString(); })()`),
  );
  check(back === 'really bold', `adding it brings focus back to Preview, with the text selected again (“${back}”)`);
  const marked = await page.evaluate(`CSS.highlights.get('rv-quote')?.size ?? 0`);
  const draftShown = await page.evaluate(`${block()}.querySelector('.rv-preview .rv-thread q.rv-quote')?.textContent ?? ''`);
  check(marked >= 1 && draftShown === 'really bold', `the comment marks its text in Preview, and its thread quotes it (${marked}, “${draftShown}”)`);

  // ── Lines, from the keyboard; the choice holds across a reload ──
  await page.evaluate(`${radio('View', 'Lines')}.focus()`);
  await press(...ENTER);
  const lines = await drawn('Lines');
  check(
    !!lines && !lines.preview && lines.lines > 5 && lines.focus === 'Lines',
    `Lines opens from the keyboard, focus stays on it, and draws the diagram and math whole (${JSON.stringify(lines)})`,
  );
  const onLine = await page.evaluate(
    `(() => { const m = ${block()}.querySelector('.g-mark[data-line="3"]'); const q = ${block()}.querySelector('.rv-doc .rv-thread q.rv-quote'); return !!m && m.closest('.rv-line')?.classList.contains('marked') && q?.textContent; })()`,
  );
  check(onLine === 'really bold', `in Lines, the comment is on its line, with its quote (“${onLine}”)`);
  await page.reload();
  await page.synced(store.state.seq);
  const kept = await drawn('Lines');
  check(!!kept, `the choice of Lines holds across a reload (${JSON.stringify(kept || (await shown()))})`);
  await page.evaluate(`${radio('View', 'Preview')}.click()`);
  await page.reload();
  await page.synced(store.state.seq);
  check(!!(await drawn('Preview')), 'and so does Preview');

  // ── A click on a diagram goes to Lines at its lines; one on text stays ──
  const at = (sel) =>
    page.evaluate(
      `(() => { const el = ${block()}.querySelector('${sel}'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`,
    );
  const click = async (p) => {
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  await page.evaluate('getSelection().removeAllRanges()');
  await click(await at('.rv-preview td [data-sl]'));
  // Nothing should change here, so this waits as long as a switch would take, and then looks.
  await sleep(300);
  const stayed = (await shown())?.mode;
  await click(await at('.rv-fig .d-bar .label'));
  const picked = await until(() => page.evaluate(`document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.getAttribute('aria-label')`));
  const pickedMode = (await shown())?.mode;
  check(
    stayed === 'Preview' && picked === 'Comment on line 12' && pickedMode === 'Lines',
    `a click on text stays in Preview (${stayed}), and one on the diagram opens Lines at its first line, with its comment box (${picked}, ${pickedMode})`,
  );
  await pressEscape();

  // ── Submit from Preview: the agent gets the line, columns and quote ──
  await page.evaluate(`${radio('View', 'Preview')}.click()`);
  await commentOn('low', 'Say how low.');
  // And a word of a code block in a list item, whose lines sit past the item’s indent.
  await commentOn('run', 'Which script?');
  await page.evaluate(`[...${block()}.querySelectorAll('button')].find((x) => x.textContent === 'Submit review').click()`);
  const heard = await until(() => calls.find((m) => m.kind === 'event' && m.event.blockId === 'notes'));
  check(
    JSON.stringify(heard?.event.values.comments) ===
      JSON.stringify([
        { line: 10, col: 11, endLine: 10, endCol: 13, quote: 'low', text: 'Say how low.' },
        { line: 23, col: 7, endLine: 23, endCol: 9, quote: 'run', text: 'Which script?' },
      ]),
    `the agent gets the comment’s line, columns and quote (${JSON.stringify(heard?.event.values.comments)})`,
  );

  // ── Full screen, from the keyboard ──
  // @drafter revises it in a turn of its own, so it needs you for revision 2.
  rt.sendMessage(thread.id, { text: '@drafter revise' });
  await until(() => itemOf('notes').revision === 2 && !rt.turns.size);
  await page.synced(store.state.seq);
  await page.waitFor(`!${block()}.querySelector('.answered-note')`, { label: 'revision 2' });
  await page.evaluate(`${block()}.querySelector('button[aria-label="Full screen"]').focus()`);
  await press(...ENTER);
  const opened2 = await until(() =>
    page.evaluate(
      `(() => { const box = ${block()}.querySelector('.rv-box.rv-full'); return box && box.getAttribute('role') === 'dialog' && document.activeElement?.getAttribute('aria-label'); })()`,
    ),
  );
  const fills = await page.evaluate(
    `(() => { const r = ${block()}.querySelector('.rv-box').getBoundingClientRect(); return r.width === innerWidth && r.height === innerHeight; })()`,
  );
  check(
    opened2 === 'Exit full screen' && fills,
    `full screen opens from the keyboard, fills the window, with focus on Exit full screen (${opened2}, ${fills})`,
  );
  await pressEscape();
  const closed = await until(() =>
    page.evaluate(`!${block()}.querySelector('.rv-box.rv-full') && document.activeElement?.getAttribute('aria-label') === 'Full screen'`),
  );
  check(!!closed, 'Escape closes it, with focus back on Full screen');

  // ── Another agent’s review ──
  const needed = JSON.stringify(store.state.sessions[sessionOf('drafter').id].needs);
  check(JSON.parse(needed)?.itemId === id, `@drafter needs you for revision 2 (${needed})`);
  const said = rt.toolsFor(sessionOf('reader').id).review_block({
    blockId: 'notes',
    verdict: 'request_changes',
    comments: [
      { line: 1, text: 'A clearer title.' },
      { line: 10, col: 11, endLine: 10, endCol: 19, quote: 'low price', text: 'Give the number.' },
    ],
  });
  check(said.ok, `@reader comments on @drafter’s review (${said.message})`);
  await until(() => !rt.turns.size);
  await page.synced(store.state.seq);
  await page.evaluate(`${radio('View', 'Lines')}.click()`);
  const theirs = await until(() =>
    page.evaluate(`(() => { const b = ${block()};
      const on = (n) => [...b.querySelectorAll('.rv-thread')].find((x) => x.querySelector('.meta b')?.textContent === '@reader' && x.textContent.includes(n));
      const t1 = on('A clearer title.'), t2 = on('Give the number.');
      return t1 && t2 && { bar: b.querySelector('.review-bar .rv-reviewers')?.textContent ?? '', quote: t2.querySelector('q.rv-quote')?.textContent,
        first: t1.previousElementSibling?.querySelector('.g-mark')?.dataset.line, open: !![...b.querySelectorAll('button')].find((x) => x.textContent === 'Submit review') }; })()`),
  );
  check(theirs?.first === '1' && theirs.quote === 'low price', `its comments show on their lines, with its name and quote (${JSON.stringify(theirs)})`);
  check(
    theirs?.bar === ' · 2 comments from @reader (Request changes)' && theirs.open,
    `the review bar says who reviewed it, and it still waits on you (“${theirs?.bar}”)`,
  );
  // Its event is a turn the person didn’t start, so it leaves what @drafter needs from you as it was.
  const needs = JSON.stringify(store.state.sessions[sessionOf('drafter').id].needs);
  check(needs === needed && calls.some((m) => m.event?.from === 'reader'), `@drafter hears it, and what it needs from you doesn’t change (${needs})`);

  // ── Dark ──
  await page.size(1280, 900, { theme: 'dark' });
  await page.reload();
  await page.synced(store.state.seq);
  await page.evaluate(`${radio('View', 'Preview')}?.click()`);
  const dark = await drawn('Preview');
  check(!!dark, `in the dark theme too, the diagram and math are drawn (${JSON.stringify(dark || (await shown()))})`);

  const logs = page.logs.filter((l) => !/example\.com/.test(l));
  check(!logs.length, `no errors in the page${logs.length ? `: ${logs.join('; ')}` : ''}`);
} finally {
  await page.close?.();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}

finish();
