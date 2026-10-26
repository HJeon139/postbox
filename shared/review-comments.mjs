// One shape for a review comment, whoever writes it (#179, #133): the person’s, sent with their verdict, and an
// agent’s on another agent’s draft. Its anchor is a line, or a selection on lines and columns with the text it quotes,
// as the W3C Web Annotation model pairs a position with a quote (www.w3.org/TR/annotation-model/#selectors): positions
// go stale when the text changes, and the quote finds the place again. An app review’s comment names a part of the
// app, and a reply names its thread. Pure, so the browser, the server and the tests share it.

import { id, int, obj, str } from './schema.mjs';

/** The longest quote a comment keeps; a longer selection is cut to it. */
export const QUOTE_MAX = 2000;
/** The longest comment, as a review thread’s comments are (catalog.mjs). */
export const COMMENT_MAX = 4000;
/** The most comments one review_block call carries, and the verdicts it can give (server/review-comments.mjs). */
export const MAX_COMMENTS = 50;
export const VERDICTS = ['comment', 'approve', 'request_changes'];

/**
 * Where a comment is: line alone, or a selection from line, col to endLine, endCol (both 1-based, endCol the column
 * of its last character) with the text it quotes.
 */
export const ANCHOR = {
  line: int({ min: 1, max: 200000 }),
  col: int({ min: 1, max: 100000 }),
  endLine: int({ min: 1, max: 200000 }),
  endCol: int({ min: 1, max: 100000 }),
  quote: str({ min: 1, max: QUOTE_MAX }),
};
const COMMENT = { ...ANCHOR, anchor: str({ min: 1, max: 80 }), threadId: id(), text: str({ min: 1, max: COMMENT_MAX }) };

/**
 * Why a comment’s or thread’s selection isn’t one, or null: col, endLine, endCol and quote come together, on a line,
 * and it ends after it starts.
 * @param {Record<string, any>} c
 */
export function anchorError(c) {
  const range = ['col', 'endLine', 'endCol', 'quote'].filter((k) => c[k] !== undefined);
  if (!range.length) return null;
  if (range.length < 4 || c.line === undefined) return 'a comment on a selection needs line, col, endLine, endCol and quote.';
  if (c.endLine < c.line || (c.endLine === c.line && c.endCol < c.col)) return 'a selection’s end (endLine, endCol) comes after its start (line, col).';
  return null;
}

/**
 * What’s wrong with one comment, as sentences that say what to fix; empty when it’s fine.
 * @param {unknown} c @param {string} path  how the sentences name it, such as comments[0]
 * @returns {string[]}
 */
export function commentErrors(c, path) {
  /** @type {string[]} */
  const errs = [];
  obj(COMMENT, ['text'])(c, path, errs);
  if (errs.length) return errs;
  const x = /** @type {Record<string, any>} */ (c);
  if (!x.text.trim()) return [`${path}.text is empty.`];
  if (x.line === undefined && x.anchor === undefined && x.threadId === undefined) return [`${path} needs a line, an anchor or a thread.`];
  const why = anchorError(x);
  return why ? [`${path}: ${why}`] : [];
}

/**
 * Where a comment points, as an agent reads it: “line 12, col 5–23 “the quoted text””, a line, a part of an app, or
 * the thread it answers.
 * @param {Record<string, any>} c
 */
export function commentAt(c) {
  if (c.line != null && c.col != null) {
    const where = c.endLine === c.line ? `line ${c.line}, col ${c.col}–${c.endCol}` : `line ${c.line}, col ${c.col} to line ${c.endLine}, col ${c.endCol}`;
    return `${where} “${c.quote}”`;
  }
  return c.line != null ? `line ${c.line}` : c.anchor != null ? `“${c.anchor}”` : c.threadId != null ? `thread ${c.threadId}` : 'the draft';
}

/**
 * The anchor of a selection from start to end, points in the source as { n, c }: a 1-based line and a 0-based offset,
 * end exclusive. Ends at a line’s edge move inside the text, and a quote past QUOTE_MAX is cut there. null when it
 * holds no text.
 * @param {string[]} lines @param {{ n: number, c: number }} start @param {{ n: number, c: number }} end
 * @returns {{ line: number, col: number, endLine: number, endCol: number, quote: string } | null}
 */
export function anchorOf(lines, start, end) {
  let s = { ...start };
  let e = { ...end };
  while (s.n < e.n && s.c >= (lines[s.n - 1] ?? '').length) s = { n: s.n + 1, c: 0 };
  while (e.n > s.n && e.c === 0) e = { n: e.n - 1, c: (lines[e.n - 2] ?? '').length };
  if (e.n < s.n || (e.n === s.n && e.c <= s.c)) return null;
  const a = { line: s.n, col: s.c + 1, endLine: e.n, endCol: e.c };
  let quote = quoteOf(lines, a);
  if (!quote.trim()) return null;
  if (quote.length > QUOTE_MAX) {
    quote = quote.slice(0, QUOTE_MAX).replace(/\n+$/, '');
    const cut = quote.split('\n');
    a.endLine = a.line + cut.length - 1;
    a.endCol = (cut.length === 1 ? s.c : 0) + (cut.at(-1) ?? '').length;
  }
  return { ...a, quote };
}

/**
 * The source text an anchor covers. @param {string[]} lines
 * @param {{ line: number, col: number, endLine: number, endCol: number }} a
 */
export function quoteOf(lines, a) {
  const out = [];
  for (let n = a.line; n <= a.endLine; n++) {
    const t = lines[n - 1] ?? '';
    out.push(t.slice(n === a.line ? a.col - 1 : 0, n === a.endLine ? a.endCol : t.length));
  }
  return out.join('\n');
}

/**
 * Where each character of a run’s rendered text came from in its source, or null. Rendering a run only drops
 * characters (emphasis marks, a link’s address, a code span’s ticks, escapes), so its text is a subsequence of its
 * source, matched in order. Drawn math isn’t, so it has none.
 * @param {string} text @param {string} src
 */
function sourceIndexes(text, src) {
  const at = [];
  let j = 0;
  for (let i = 0; i < text.length; i++, j++) {
    while (j < src.length && src[j] !== text[i]) j++;
    if (j === src.length) return null;
    at.push(j);
  }
  return at;
}

/**
 * Where offset k of a run’s rendered text falls in the run’s source (#179). A start is its character’s place, and an
 * end the place after the character before it, so a selection takes none of the marks around it. A run whose text
 * isn’t in its source snaps to its edges.
 * @param {string} text @param {string} src @param {number} k @param {'start' | 'end'} side
 */
export function toSource(text, src, k, side) {
  const at = sourceIndexes(text, src);
  if (!at) return (side === 'start' ? k >= text.length : k > 0) ? src.length : 0;
  if (side === 'start') return k < at.length ? at[k] : src.length;
  return k > 0 ? at[k - 1] + 1 : 0;
}

/**
 * The inverse of toSource: the offset in a run’s rendered text of place p in its source.
 * @param {string} text @param {string} src @param {number} p @param {'start' | 'end'} side
 */
export function toText(text, src, p, side) {
  const at = sourceIndexes(text, src);
  if (!at) return (side === 'start' ? p >= src.length : p > 0) ? text.length : 0;
  return at.filter((x) => x < p).length;
}
