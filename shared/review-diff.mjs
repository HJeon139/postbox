// The line diff a review block draws a revision with, and how draft comments follow their lines into the next text
// (#123). Moved out of app/js/blocks.mjs. Pure, so the browser and the tests share it.

export const splitLines = (src) => String(src ?? '').split(/\r\n?|\n/);

/**
 * Moves draft comments from lines of one text to the same lines of the next (#123). A comment on a line that changed
 * goes to the line that replaced it; one on a line that went, to the next line after it, or the last. Either is
 * marked moved.
 * @param {{ line?: number, text: string, moved?: boolean }[]} comments @param {string} from @param {string} to
 */
export function followLines(comments, from, to) {
  if (!comments.some((c) => typeof c.line === 'number')) return comments;
  const rows = diffLines(splitLines(from), splitLines(to));
  const last = splitLines(to).length;
  return comments.map((c) => {
    const i = rows.findIndex((r) => r.o === c.line);
    if (i < 0) return c;
    if (rows[i].kind === 'same') return { ...c, line: rows[i].n };
    return { ...c, line: rows.slice(i).find((r) => r.n !== undefined)?.n ?? last, moved: true };
  });
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
