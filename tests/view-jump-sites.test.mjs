// #712: transcript items skip layout off screen (content-visibility), so a jump to one has to go through jumpTo
// (app/js/view-jump.mjs), which makes the target the anchor until the person scrolls. A plain scrollIntoView, or a focus
// that scrolls, lands where the estimates put the item, and the items between drawing push it away. This finds every
// such call in app/js/ and fails on one that isn't named below with its reason.
//
// scrollIntoView is checked in every module. A focus() without preventScroll is checked only in the modules that render
// or jump to transcript items: most focus calls are on fields and buttons in panels and dialogs, and which element a
// call reaches can't be told from the source alone.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const DIR = new URL('../app/js/', import.meta.url);
const TRANSCRIPT_MODULES = [
  'thread.mjs',
  'apps.mjs',
  'needs-nav.mjs',
  'side-line.mjs',
  'keys.mjs',
  'hover-content.mjs',
  'blocks.mjs',
  'go-to-item.mjs',
  'work-sections.mjs',
];

/** Calls allowed to scroll on their own: matched by file and a piece of the line, so edits elsewhere don't move them. */
const ALLOWED = [
  { file: 'view-jump.mjs', snippet: 'el.scrollIntoView({ block })', why: 'jumpTo’s own fallback, for an element outside a transcript' },
  { file: 'permissions.mjs', snippet: "'perm-mcp' : 'perm-dir')?.scrollIntoView(", why: 'a field in the permissions dialog' },
  { file: 'thread.mjs', snippet: 'slash.index}`)?.scrollIntoView(', why: 'the slash menu’s active option, above the composer' },
  { file: 'thread.mjs', snippet: 'ta.focus()', why: 'the composer’s text box, outside the transcript' },
  { file: 'thread.mjs', snippet: "$('#side-input')?.focus()", why: 'the side thread’s composer, outside the transcript' },
  { file: 'thread.mjs', snippet: "hint.querySelector('.did-you-mean')?.focus()", why: 'the composer’s “Did you mean” hint' },
  { file: 'thread.mjs', snippet: 'asks.querySelector(`[data-key=', why: 'the stop ask above the composer' },
  { file: 'thread.mjs', snippet: '(action.isConnected ? action : ta).focus()', why: 'the stop ask above the composer, or the composer' },
  { file: 'apps.mjs', snippet: 'lastFocus.focus()', why: 'focus taken back from an app’s frame, to where it was' },
  { file: 'apps.mjs', snippet: '.app-retired [aria-haspopup]`)?.focus()', why: 'closing a retired app returns to its own line, where you were' },
  { file: 'apps.mjs', snippet: 'rec.btn.focus()', why: 'the full screen button of the app you just used' },
  { file: 'apps.mjs', snippet: 'to?.focus()', why: 'Tab kept inside a full screen app' },
  { file: 'blocks.mjs', snippet: '.chip[data-n=', why: 'the option you picked, kept as its block re-renders' },
  { file: 'blocks.mjs', snippet: 'all[(i + dir + all.length) % all.length].focus()', why: 'the arrow keys between options of the block you’re in' },
  { file: 'blocks.mjs', snippet: 'first}`)?.focus()', why: 'the first field with an error, in the form you sent' },
  { file: 'blocks.mjs', snippet: "th[aria-sort] button')?.focus()", why: 'the column header you sorted by, as its table re-renders' },
];

/**
 * Each call in src that can scroll: scrollIntoView, and (when focus is set) a focus() without preventScroll.
 * @param {string} src @param {{ focus: boolean }} opts
 */
function scrollCalls(src, { focus }) {
  const found = [];
  src.split('\n').forEach((raw, i) => {
    // A JSDoc cast (/** @type … */) can open a line of code: only what's left once inline comments go is read.
    const line = raw.replace(/\/\*.*?\*\//g, '');
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (/\.scrollIntoView(IfNeeded)?\(/.test(line)) found.push({ line: i + 1, text: line.trim() });
    else if (focus && [...line.matchAll(/\.focus\(([^)]*)\)?/g)].some((m) => !m[1].includes('preventScroll'))) found.push({ line: i + 1, text: line.trim() });
  });
  return found;
}

const hits = readdirSync(DIR)
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .flatMap((file) => scrollCalls(readFileSync(new URL(file, DIR), 'utf8'), { focus: TRANSCRIPT_MODULES.includes(file) }).map((c) => ({ file, ...c })));
const allowance = (h) => ALLOWED.find((a) => a.file === h.file && h.text.includes(a.snippet));

test('the scan finds scrollIntoView and a focus that scrolls, and passes over preventScroll and comments', () => {
  const src = [
    'a.scrollIntoView({ block: "center" });',
    'b.focus();',
    'c.focus({ preventScroll: true });',
    '// d.scrollIntoView()',
    'e.focus(opts);',
    '/** @type {HTMLElement} */ (f).focus();',
  ].join('\n');
  assert.deepEqual(
    scrollCalls(src, { focus: true }).map((c) => c.line),
    [1, 2, 5, 6],
  );
  assert.deepEqual(
    scrollCalls(src, { focus: false }).map((c) => c.line),
    [1],
  );
});

test('the scan reads every module in app/js, so a pass is not a scan of nothing', () => {
  assert.ok(
    hits.some((h) => h.file === 'view-jump.mjs'),
    'jumpTo’s own scrollIntoView was not found',
  );
  for (const f of TRANSCRIPT_MODULES) assert.ok(readdirSync(DIR).includes(f), `${f} is gone: update TRANSCRIPT_MODULES`);
});

test('every jump in app/js goes through jumpTo, apart from the calls named with their reasons', () => {
  const stray = hits.filter((h) => !allowance(h)).map((h) => `app/js/${h.file}:${h.line}: ${h.text}`);
  assert.deepEqual(stray, [], `Scroll with jumpTo(el, block) from view-jump.mjs, and focus with { preventScroll: true }:\n${stray.join('\n')}`);
});

test('each allowed call is still in app/js, so the list doesn’t keep a stale exception', () => {
  const stale = ALLOWED.filter((a) => !hits.some((h) => allowance(h) === a)).map((a) => `${a.file}: ${a.snippet}`);
  assert.deepEqual(stale, []);
});
