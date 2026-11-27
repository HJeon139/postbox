// One shape for a review comment, whoever writes it (#179, #133): the person’s, sent with their verdict, and an
// agent’s on another agent’s draft. Its anchor is a line, or a selection on lines and columns with the text it quotes,
// as the W3C Web Annotation model pairs a position with a quote (www.w3.org/TR/annotation-model/#selectors): positions
// go stale when the text changes, and the quote finds the place again. An app review’s comment names a part of the
// app, or a region the person marked on it (#856), and a reply names its thread. Pure, so the browser, the server and
// the tests share it.

import { HANDLE, PERSON, REVIEW_THREADS_BYTES, REVIEW_THREADS_MAX, REVIEW_THREADS_OPEN } from './limits.mjs';
import { described, id, int, obj, str } from './schema.mjs';
import { cutText } from './text-parts.mjs';

/** The longest quote a comment keeps; a longer selection is cut to it. */
export const QUOTE_MAX = 2000;
/** The longest comment, as a review thread’s comments are (catalog.mjs). */
export const COMMENT_MAX = 4000;
/** The most comments one review_block call carries, and the verdicts it can give (server/review-comments.mjs). */
export const MAX_COMMENTS = 50;
export const VERDICTS = ['comment', 'approve', 'request_changes'];

// How the person’s comments are stored in a review’s threads (#1143): only their answer writes it.
export { PERSON };
/** A comment’s author as people and agents read it: You, or an agent’s @handle. @param {string} author */
export const authorName = (author) => (author === PERSON ? 'You' : author);
/**
 * The catalog’s rule for a review thread comment’s author (#1143): PERSON or an agent’s @handle, so no other name
 * reads as the person’s, such as “You”, or as no one’s. Only the person’s answer writes PERSON: show_block refuses it.
 * The page shows a handle without its @, so @you, in any case, would read as the person too.
 * @type {import('./schema.mjs').Rule}
 */
export const author = described(
  (v, path, errs) => {
    const handle = typeof v === 'string' && v[0] === '@' ? v.slice(1) : '';
    const ok = v === PERSON || (HANDLE.test(handle) && handle.toLowerCase() !== PERSON);
    if (!ok) errs.push(`${path} must be an agent’s @handle, such as @critic.`);
  },
  // What an agent may write: an @handle, which the check above reads with HANDLE. Only the person’s answer writes
  // PERSON, and show_block refuses it.
  { type: 'string', pattern: '^@' },
);

const ENCODER = new TextEncoder();
/** What the agent can do about a review past its bounds (threadsError), and what the person can, by the review’s agent. */
const AGENT_NEXT = { open: 'resolve some, or show a new review block with the text so far.', fresh: 'show a new review block with the text so far.' };
/** @param {string} handle */
export const personNext = (handle) => ({
  open: `ask @${handle} to resolve the ones they’ve handled, or to show a new review block, and comment there.`,
  fresh: `ask @${handle} to show a new review block with the text so far, and comment there.`,
});

/**
 * Adds to errs why a review’s threads are past their bounds (#1143): more than REVIEW_THREADS_OPEN open (only open
 * ones count, so resolving one frees its place), more than REVIEW_THREADS_MAX in all, or more than
 * REVIEW_THREADS_BYTES of comment text in UTF-8. One pass over its comments. next says what to do: the agent’s by
 * default, or personNext for the person, who can’t resolve a thread or show a block.
 * @param {unknown} threads  a review’s threads, checked as a list by the catalog @param {string[]} errs
 * @param {{ open: string, fresh: string }} [next]
 */
export function threadsError(threads, errs, next = AGENT_NEXT) {
  if (!Array.isArray(threads)) return;
  if (threads.length > REVIEW_THREADS_MAX)
    return errs.push(`A review holds up to ${REVIEW_THREADS_MAX.toLocaleString('en-US')} threads, open and resolved: ${next.fresh}`);
  let open = 0;
  let bytes = 0;
  for (const t of threads) {
    if (t?.status === 'open') open++;
    for (const c of Array.isArray(t?.comments) ? t.comments : []) if (typeof c?.text === 'string') bytes += ENCODER.encode(c.text).length;
  }
  if (bytes > REVIEW_THREADS_BYTES) errs.push(`A review’s threads hold up to ${REVIEW_THREADS_BYTES / 1024 / 1024} MB of comment text: ${next.fresh}`);
  if (open > REVIEW_THREADS_OPEN) errs.push(`A review has up to ${REVIEW_THREADS_OPEN} open threads: ${next.open}`);
}

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

/** A fraction of the app’s width or height, from 0 to 1. @type {import('./schema.mjs').Rule} */
const fraction = described(
  (v, path, errs) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) errs.push(`${path} must be a number from 0 to 1, a fraction of the app’s size.`);
  },
  { type: 'number', minimum: 0, maximum: 1 },
);
/**
 * A region of an app the person marked in its review (#856): its left edge x, top y, width w and height h as fractions
 * of the app’s width and height, so it holds at any window size, and the app version it was made on, since another
 * version may draw something else there. w and h of 0 is a point.
 */
export const REGION = obj({ x: fraction, y: fraction, w: fraction, h: fraction, version: int({ min: 1, max: 1_000_000 }) }, ['x', 'y', 'w', 'h', 'version']);
/** The anchor a region comment is grouped and threaded by, as a named part is: “region 1”, numbered in its review. */
export const REGION_ANCHOR = /^region [1-9]\d*$/;

/**
 * Why a comment’s or thread’s region isn’t one, or null: it stays inside the app, and is named by its anchor, “region
 * 1”. The fields themselves are checked by REGION.
 * @param {Record<string, any>} c
 */
export function regionError(c) {
  const r = c.region;
  if (r === undefined || r === null || typeof r !== 'object') return null;
  // Within a rounding error: 0.7 + 0.3 is 1.0000000000000002 in floating point.
  if (r.x + r.w > 1 + 1e-9 || r.y + r.h > 1 + 1e-9) return 'a region stays inside the app: x + w and y + h are at most 1.';
  if (typeof c.anchor !== 'string' || !REGION_ANCHOR.test(c.anchor)) return 'a comment on a region names it as anchor, such as “region 1”.';
  return null;
}

/**
 * Why a new comment names a region it doesn’t carry, or null: “region 1”, “region 2” and so on are the regions the
 * person marks, so a part can’t take that name (#856). Checked on comments as they come in, not on a review’s stored
 * threads: a part an app named that way before #856 keeps its thread. @param {Record<string, any>} c
 */
export function regionNameError(c) {
  if (c.region != null || typeof c.anchor !== 'string' || !REGION_ANCHOR.test(c.anchor)) return null;
  return `“${c.anchor}” names a marked region, so it needs its region: { x, y, w, h, version }.`;
}

/** Whether two regions are the same place on the same version. @param {any} a @param {any} b */
export const sameRegion = (a, b) => ['x', 'y', 'w', 'h', 'version'].every((k) => a?.[k] === b?.[k]);

/**
 * Why a review’s threads name one region twice, as sentences: each “region N” is one place, so two threads on it with
 * different regions would draw one and list the other in the wrong place (#856). @param {any[]} threads
 */
export function regionClashes(threads) {
  const seen = new Map();
  const errs = [];
  for (const [i, t] of threads.entries()) {
    if (!t?.region || typeof t.anchor !== 'string') continue;
    const first = seen.get(t.anchor);
    if (first && !sameRegion(first.region, t.region))
      errs.push(`threads[${i}]: “${t.anchor}” is already threads[${first.i}]’s region; give this one the next number.`);
    else if (!first) seen.set(t.anchor, { i, region: t.region });
  }
  return errs;
}

/** A percentage as people read it: 12%, or 12.5% where the tenth matters. @param {number} f  a fraction */
const pct = (f) => `${Math.round(f * 1000) / 10}%`;
/**
 * A region as text (#856): “x 12%, y 30%, 20% × 15%, on v3”, or “a point at x 12%, y 30%, on v3”. Every drawn region
 * is also said this way, to the agent and on the page. @param {{ x: number, y: number, w: number, h: number, version: number }} r
 */
export function regionText(r) {
  const at = `x ${pct(r.x)}, y ${pct(r.y)}`;
  return r.w === 0 && r.h === 0 ? `a point at ${at}, on v${r.version}` : `${at}, ${pct(r.w)} × ${pct(r.h)}, on v${r.version}`;
}

const COMMENT = { ...ANCHOR, anchor: str({ min: 1, max: 80 }), region: REGION, threadId: id(), text: str({ min: 1, max: COMMENT_MAX }) };

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
  const why = anchorError(x) ?? regionError(x) ?? regionNameError(x);
  return why ? [`${path}: ${why}`] : [];
}

/**
 * Where a comment points, as an agent reads it: “line 12, col 5–23 “the quoted text””, a line, a part of an app, a
 * region of it (“region 1” (x 12%, y 30%, 20% × 15%, on v3)), or the thread it answers.
 * @param {Record<string, any>} c
 */
export function commentAt(c) {
  if (c.line != null && c.col != null) {
    const where = c.endLine === c.line ? `line ${c.line}, col ${c.col}–${c.endCol}` : `line ${c.line}, col ${c.col} to line ${c.endLine}, col ${c.endCol}`;
    return `${where} “${c.quote}”`;
  }
  if (c.anchor != null && c.region != null) return `“${c.anchor}” (${regionText(c.region)})`;
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
    quote = cutText(quote, QUOTE_MAX).replace(/\n+$/, '');
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
