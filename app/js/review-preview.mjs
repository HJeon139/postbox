// A review’s Preview (#179): the whole draft as renderMarkdown draws it, diagrams and math included, with each comment
// after the part of the draft it’s on. Selecting text shows a Comment button beside it, next in the tab order, so a
// keyboard selection reaches it too. The selection’s ends map to source lines and columns through the renderer’s
// source marks (renderMarkdown’s positions) and shared/review-comments.mjs. A diagram, display math or an image can’t
// be selected inside, so a click on one goes to Lines, with the comment box of its lines open.

import { renderMarkdown } from '/shared/markdown.mjs';
import { anchorOf, toSource, toText } from '/shared/review-comments.mjs';
import { splitLines } from '/shared/review-diff.mjs';
import { enhanceMarkdown } from './apps.mjs';
import { h, icon, trusted } from './dom.mjs';

/** Each Preview’s source lines, for putting a selection back. @type {WeakMap<Element, string[]>} */
const sources = new WeakMap();

/**
 * @param {string} src  the draft
 * @param {{ id: string, done: boolean, keys: number[], composing: any, ranged: any[], threadBox: (key: any) => HTMLElement[],
 *   comment: (anchor: any) => void, pick: (line: number) => void }} env
 *   keys: the lines with threads or draft comments; composing: the selection being commented on, if any; ranged: the
 *   threads and drafts on selections, to mark; comment: a Comment button was pressed; pick: a click chose a line
 */
export function renderPreview(src, env) {
  const lines = splitLines(src);
  const md = h('div.md', { html: trusted(renderMarkdown(src, { folds: false, positions: true, pageOrigin: location.origin })) });
  // A diagram is drawn into a new element (enhanceMarkdown), so its lines go on a box around it first.
  for (const fig of md.querySelectorAll('figure.md-mermaid')) {
    const box = h('div.rv-fig', { dataset: { sl: fig.getAttribute('data-sl'), el: fig.getAttribute('data-el') } });
    fig.replaceWith(box);
    box.append(fig);
  }
  const root = h('div.rv-doc.rv-preview', { role: 'region', 'aria-label': 'Preview', tabindex: '-1' }, md);
  sources.set(root, lines);
  placeThreads(md, env);
  if (!env.done) selecting(root, md, lines, env);
  mark(
    env.id,
    env.ranged.map((a) => rangeOf(md, lines, a)).filter((r) => r !== null),
  );
  queueMicrotask(() => enhanceMarkdown(md));
  return root;
}

/**
 * Puts focus back in a block’s Preview, with the text a comment is on selected, as it was before its comment box.
 * @param {HTMLElement} node  the block @param {any} a  the anchor
 */
export function focusQuote(node, a) {
  const root = node.querySelector('.rv-preview');
  const md = root?.querySelector(':scope > .md');
  const lines = root && sources.get(root);
  if (!(root instanceof HTMLElement) || !md || !lines) return;
  root.focus({ preventScroll: true });
  const r = rangeOf(md, lines, a);
  if (!r) return;
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(r);
}

/** The source marks of a part of the draft, a run or a block: [first line, last line], or null. @param {Element} el */
function linesOf(el) {
  const marks = [el, ...el.querySelectorAll('[data-sl]')].filter((m) => m instanceof HTMLElement && m.dataset.sl);
  if (!marks.length) return null;
  const at = marks.flatMap((m) => [+(/** @type {HTMLElement} */ (m.dataset.sl ?? 0)), +(/** @type {HTMLElement} */ (m.dataset.el ?? 0))]);
  return [Math.min(...at.filter(Boolean)), Math.max(...at)];
}

/** Each line’s threads and drafts go after the part of the draft that holds it, or the next one after a blank line. */
function placeThreads(md, { keys, composing, threadBox }) {
  const parts = [...md.children].map((el) => ({ el, lines: linesOf(el), tail: el })).filter((p) => p.lines);
  const after = (line) => parts.find((p) => p.lines?.[1] >= line) ?? parts.at(-1);
  const put = (line, nodes) => {
    const p = after(line);
    if (!p) return md.append(...nodes);
    p.tail.after(...nodes);
    p.tail = nodes.at(-1) ?? p.tail;
  };
  for (const key of keys) put(key, threadBox(key));
  if (composing && typeof composing === 'object') put(composing.line, threadBox(composing));
}

/** The part of the draft (a child of the rendered Markdown) a node is in. @param {Element} md @param {Node} node */
function partOf(md, node) {
  let el = node instanceof Element ? node : node.parentElement;
  while (el && el.parentElement !== md) el = el.parentElement;
  return el;
}

/** The Comment button beside a selection, and a click that selects nothing, which picks a line. */
function selecting(root, md, lines, env) {
  /** @type {any} */
  let anchor = null;
  const btn = h(
    'button.btn.sm.rv-sel',
    // Pressing it mustn’t take the selection away before it’s read.
    { type: 'button', hidden: true, onmousedown: (e) => e.preventDefault(), onclick: () => anchor && env.comment(anchor) },
    icon('comment', 'i-sm'),
    'Comment',
  );
  root.append(btn);
  const update = () => {
    if (!root.isConnected) return document.removeEventListener('selectionchange', update);
    const sel = getSelection();
    const r = sel?.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    const inside = r && md.contains(r.startContainer) && md.contains(r.endContainer) && !partOf(md, r.startContainer)?.matches('.rv-thread');
    anchor = inside ? selectionAnchor(md, lines, r) : null;
    btn.hidden = !anchor;
    if (!anchor || !r) return;
    // Beside the selection’s end, and next in the tab order after it: right after the run or block it ends in, which
    // keeps every run’s text as it was. Moved only when it isn’t there already: moving it would take its focus away.
    const box = r.getBoundingClientRect();
    const at = root.getBoundingClientRect();
    btn.style.top = `${box.bottom - at.top + 4}px`;
    btn.style.left = `${Math.max(8, Math.min(box.right - at.left - 40, at.width - 110))}px`;
    const end = r.endContainer instanceof Element ? r.endContainer : r.endContainer.parentElement;
    const place = end?.closest('[data-sl]') ?? partOf(md, r.endContainer);
    if (place && place.nextSibling !== btn) place.after(btn);
  };
  document.addEventListener('selectionchange', update);
  // A click that only clears a selection, or one on text, which can be selected, stays in Preview.
  let selected = false;
  root.addEventListener('mousedown', () => {
    selected = !getSelection()?.isCollapsed;
  });
  root.addEventListener('click', (e) => {
    const t = /** @type {Element} */ (e.target);
    const whole = t.closest('.rv-fig, .md-math[data-display], img.md-img, .md-img-failed, .img-failed');
    if (selected || !whole || !md.contains(whole) || t.closest('a, button') || !getSelection()?.isCollapsed) return;
    const m = whole.closest('[data-sl]');
    if (m instanceof HTMLElement) env.pick(+(m.dataset.sl ?? 0));
  });
}

/** A selection’s anchor in the source. @param {Element} md @param {string[]} lines @param {Range} r */
function selectionAnchor(md, lines, r) {
  const marks = /** @type {HTMLElement[]} */ ([...md.querySelectorAll('[data-sl]')]);
  const s = sourcePoint(marks, lines, r.startContainer, r.startOffset, 'start');
  const e = sourcePoint(marks, lines, r.endContainer, r.endOffset, 'end');
  return s && e ? anchorOf(lines, s, e) : null;
}

/**
 * Where a point of the page is in the source, as { n: line, c: offset }. In a run, through its text; in a diagram,
 * math or code block, its whole lines. Between them, the next mark for a start and the one before for an end.
 * @param {HTMLElement[]} marks @param {string[]} lines @param {Node} node @param {number} offset @param {'start' | 'end'} side
 */
function sourcePoint(marks, lines, node, offset, side) {
  const p = document.createRange();
  p.setStart(node, offset);
  let m = marks.findLast((x) => x.contains(node));
  let k = 0;
  if (m) {
    const t = document.createRange();
    t.selectNodeContents(m);
    t.setEnd(node, offset);
    k = t.toString().length;
  } else if (side === 'start') m = marks.find((x) => p.comparePoint(x, 0) > 0);
  else {
    m = marks.findLast((x) => p.comparePoint(x, x.childNodes.length) < 0);
    k = m?.textContent?.length ?? 0;
  }
  if (!m) return null;
  const n = +(m.dataset.sl ?? 0);
  // A code block’s text is its lines as they are, after the fence’s first line, less any quote marker or list indent
  // in front of them (codeIndent).
  if (m.matches('pre.md-code')) {
    const before = (m.textContent ?? '').slice(0, k).split('\n');
    const at = n + before.length;
    return { n: at, c: codeIndent(m, lines, at) + (before.at(-1) ?? '').length };
  }
  if (m.dataset.el) return side === 'start' ? { n, c: 0 } : { n: +m.dataset.el, c: (lines[+m.dataset.el - 1] ?? '').length };
  const sc = +(m.dataset.sc ?? 0);
  return { n, c: sc + toSource(m.textContent ?? '', (lines[n - 1] ?? '').slice(sc, +(m.dataset.se ?? 0)), k, side) };
}

/** The page’s range for an anchor, or null. @param {Element} md @param {string[]} lines @param {any} a */
function rangeOf(md, lines, a) {
  const marks = /** @type {HTMLElement[]} */ ([...md.querySelectorAll('[data-sl]')]);
  const s = pagePoint(marks, lines, a.line, a.col - 1, 'start');
  const e = pagePoint(marks, lines, a.endLine, a.endCol, 'end');
  if (!s || !e) return null;
  const r = document.createRange();
  r.setStart(s[0], s[1]);
  r.setEnd(e[0], e[1]);
  return r;
}

/**
 * Where place c of source line n is on the page, as [node, offset]: in the run that holds it, or the whole block.
 * @param {HTMLElement[]} marks @param {string[]} lines @param {number} n @param {number} c @param {'start' | 'end'} side
 * @returns {[Node, number] | null}
 */
function pagePoint(marks, lines, n, c, side) {
  const block = (x) => x.dataset.el && +(x.dataset.sl ?? 0) <= n && n <= +x.dataset.el;
  const run = (x) => !x.dataset.el && +(x.dataset.sl ?? 0) === n;
  const holds = (x) => +(x.dataset.sc ?? 0) <= c && (side === 'start' ? c < +(x.dataset.se ?? 0) : c <= +(x.dataset.se ?? 0));
  const m =
    marks.find((x) => block(x) || (run(x) && holds(x))) ??
    (side === 'start' ? marks.find((x) => run(x) && +(x.dataset.sc ?? 0) >= c) : marks.findLast((x) => run(x) && +(x.dataset.se ?? 0) <= c));
  if (!m) return null;
  const sl = +(m.dataset.sl ?? 0);
  const code = m.matches('pre.md-code') && n > sl;
  if (m.dataset.el && !code) return side === 'start' ? [m, 0] : [m, m.childNodes.length];
  const sc = +(m.dataset.sc ?? 0);
  const se = +(m.dataset.se ?? 0);
  let k = code
    ? (m.textContent ?? '')
        .split('\n')
        .slice(0, n - sl - 1)
        .reduce((sum, l) => sum + l.length + 1, 0) + Math.max(0, c - codeIndent(m, lines, n))
    : toText(m.textContent ?? '', (lines[n - 1] ?? '').slice(sc, se), Math.min(Math.max(c, sc), se) - sc, side);
  const walk = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const len = /** @type {Text} */ (t).data.length;
    if (k <= len) return [t, k];
    k -= len;
  }
  return [m, m.childNodes.length];
}

/**
 * What a code block’s line n lost in front of it: the quote marker or list indent its source line has, which is the
 * rest of that line past the code. @param {Element} pre @param {string[]} lines @param {number} n
 */
function codeIndent(pre, lines, n) {
  const code = (pre.textContent ?? '').split('\n')[n - +(/** @type {HTMLElement} */ (pre.dataset.sl ?? 0)) - 1] ?? '';
  return Math.max(0, (lines[n - 1] ?? '').length - code.length);
}

/** Each review’s marked ranges, painted as one highlight. @type {Map<string, Range[]>} */
const marked = new Map();
/** Marks the text each comment on a selection is on (CSS Custom Highlight; ::highlight(rv-quote) in workbench.css). */
function mark(id, ranges) {
  if (!globalThis.CSS?.highlights || typeof Highlight === 'undefined') return;
  // A block is drawn before it’s on the page, so a range off the page may be one about to be: only a long list of
  // them, from reviews no longer shown, is cleared.
  if (marked.size > 50) for (const [k, v] of marked) if (k !== id && !v[0]?.startContainer.isConnected) marked.delete(k);
  marked.set(id, ranges);
  CSS.highlights.set('rv-quote', new Highlight(...[...marked.values()].flat()));
}
