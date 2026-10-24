// The line diff a review block draws a revision with, and how draft comments follow their lines into the next text
// (#123). Moved out of app/js/blocks.mjs. Pure, so the browser and the tests share it.

export const splitLines = (src) => String(src ?? '').split(/\r\n?|\n/);

/**
 * Moves comments from lines of one text to the same lines of the next (#123). A comment on a line that changed goes to
 * the line that replaced it; one on a line that went, to the next line after it, or the last. Either is marked moved.
 * A comment on a selection (#179) follows its quote instead, to where it is nearest that line. When the quote is gone,
 * it’s a comment on that line, marked moved, and gone keeps the quote it had.
 * @template {{ line?: number, col?: number, endLine?: number, endCol?: number, quote?: string, moved?: boolean, gone?: string }} C
 * @param {C[]} comments @param {string} from @param {string} to
 * @returns {C[]}
 */
export function followLines(comments, from, to) {
  if (!comments.some((c) => typeof c.line === 'number')) return comments;
  const rows = diffLines(splitLines(from), splitLines(to));
  const last = splitLines(to).length;
  return comments.map((c) => {
    const i = rows.findIndex((r) => r.o === c.line);
    if (i < 0) return c;
    const same = rows[i].kind === 'same';
    const line = same ? /** @type {number} */ (rows[i].n) : (rows.slice(i).find((r) => r.n !== undefined)?.n ?? last);
    if (typeof c.quote !== 'string' || typeof c.col !== 'number') return same ? { ...c, line } : { ...c, line, moved: true };
    const found = findQuote(to, c.quote, line);
    const { col: _c, endLine: _l, endCol: _e, quote, moved: _m, gone: _g, ...rest } = c;
    return /** @type {C} */ (found ? { ...rest, ...found, quote } : { ...rest, line, moved: true, gone: quote });
  });
}

/**
 * Where quote is in text, the place nearest line if it’s there more than once, as an anchor (1-based lines and
 * columns, endCol its last character’s); or null. One pass over the text, so a server can run it on a long draft.
 * @param {string} text @param {string} quote @param {number} line
 * @returns {{ line: number, col: number, endLine: number, endCol: number } | null}
 */
export function findQuote(text, quote, line) {
  const t = text.replace(/\r\n?/g, '\n');
  const q = quote.replace(/\r\n?/g, '\n');
  if (!q) return null;
  const inside = q.split('\n');
  /** @type {{ line: number, col: number, endLine: number, endCol: number } | null} */
  let best = null;
  let n = 1;
  let start = 0;
  let at = 0;
  for (let k = t.indexOf(q); k > -1; k = t.indexOf(q, k + 1)) {
    for (; at < k; at++)
      if (t[at] === '\n') {
        n++;
        start = at + 1;
      }
    // Past the line, each later match is farther than the last.
    if (best && Math.abs(n - line) >= Math.abs(best.line - line)) {
      if (n > line) break;
      continue;
    }
    const col = k - start + 1;
    best = { line: n, col, endLine: n + inside.length - 1, endCol: (inside.length === 1 ? col - 1 : 0) + (inside.at(-1) ?? '').length };
  }
  return best;
}

/** A line diff (longest common subsequence), good enough for documents up to a few thousand lines. */
export function diffLines(a, b) {
  const n = a.length,
    m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: b[j], kind: 'same', n: j + 1, o: i + 1 });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      out.push({ t: a[i], kind: 'del', o: i + 1 });
      i++;
    } else {
      out.push({ t: b[j], kind: 'add', n: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ t: a[i], kind: 'del', o: i + 1 });
    i++;
  }
  while (j < m) {
    out.push({ t: b[j], kind: 'add', n: j + 1 });
    j++;
  }
  // Group each run of removals before its additions, the way people read a diff.
  return out;
}
