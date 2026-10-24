// Line diffs for the work ledger (#132): lines added and deleted as git counts them, and a diff to show. Moved from
// shared/work.mjs, which re-exports each function here.

/** Whether bytes look binary, as git decides: a NUL in the first 8,000 bytes. */
export function isBinary(bytes) {
  const n = Math.min(bytes?.length ?? 0, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// The last line without a newline is a different line from the same text with one, so adding the final newline
// counts as one line deleted and one added, as git counts it.
const NOEOL = '\u0000';
/** A text’s lines, the way a diff sees them. */
export function splitLines(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const lines = s.split('\n');
  if (lines.at(-1) === '') lines.pop();
  else lines[lines.length - 1] += NOEOL;
  return lines;
}
const shown = (t) => (t.endsWith(NOEOL) ? t.slice(0, -1) : t);

/** The number of lines two texts share at their start and at their end. */
function trim(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { pre, suf };
}

/**
 * The shortest edit script’s length between two line arrays (Myers), or -1 past `max`. Only the length: lines added
 * and deleted follow from it and the two lengths, so counting needs no path and little memory.
 */
function editDistance(a, b, max) {
  const n = a.length;
  const m = b.length;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return -1;
}

/**
 * Lines added and deleted between two texts, as `git diff --numstat` counts them.
 * @returns {{ added: number, deleted: number }}
 */
export function diffCount(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  const { pre, suf } = trim(a, b);
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  if (!ma.length || !mb.length) return { added: mb.length, deleted: ma.length };
  // Past this many edits, a minimal script costs more than it tells: count the middle as replaced.
  const d = editDistance(ma, mb, Math.min(ma.length + mb.length, 5000));
  if (d < 0) return { added: mb.length, deleted: ma.length };
  return { added: (d + mb.length - ma.length) / 2, deleted: (d - mb.length + ma.length) / 2 };
}

/**
 * A line diff to show: rows of { t, kind: 'same' | 'add' | 'del', o?, n? }, where o and n are line numbers in the
 * old and new text. It is minimal (Myers) when the texts differ by at most `maxEdits` lines, and otherwise shows
 * the changed middle as removed, then added.
 */
export function diffRows(before, after, { maxEdits = 2000 } = {}) {
  const a = splitLines(before);
  const b = splitLines(after);
  const { pre, suf } = trim(a, b);
  const rows = [];
  for (let i = 0; i < pre; i++) rows.push({ t: shown(a[i]), kind: 'same', o: i + 1, n: i + 1 });
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  const middle = myersPath(ma, mb, maxEdits);
  if (middle)
    for (const r of middle)
      rows.push(
        r.kind === 'same'
          ? { t: shown(mb[r.j]), kind: 'same', o: pre + r.i + 1, n: pre + r.j + 1 }
          : r.kind === 'del'
            ? { t: shown(ma[r.i]), kind: 'del', o: pre + r.i + 1 }
            : { t: shown(mb[r.j]), kind: 'add', n: pre + r.j + 1 },
      );
  else {
    for (let i = 0; i < ma.length; i++) rows.push({ t: shown(ma[i]), kind: 'del', o: pre + i + 1 });
    for (let j = 0; j < mb.length; j++) rows.push({ t: shown(mb[j]), kind: 'add', n: pre + j + 1 });
  }
  for (let s = 0; s < suf; s++) {
    const i = a.length - suf + s;
    const j = b.length - suf + s;
    rows.push({ t: shown(b[j]), kind: 'same', o: i + 1, n: j + 1 });
  }
  return rows;
}

/** Myers with its trace, for a diff to show; null when the texts differ by more than max lines. */
function myersPath(a, b, max) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  const limit = Math.min(n + m, max);
  const off = limit + 1;
  const trace = [];
  const v = new Int32Array(2 * limit + 3);
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  // Walk back from the end through each step’s saved row.
  const out = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const row = trace[d]; // v as it was before step d, from k = -d-1 to d+1
    const at = (k) => row[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) out.push({ kind: 'same', i: --x, j: --y });
    if (x === prevX) out.push({ kind: 'add', j: --y });
    else out.push({ kind: 'del', i: --x });
  }
  while (x > 0 && y > 0) out.push({ kind: 'same', i: --x, j: --y });
  return out.reverse();
}

/**
 * Rows grouped into hunks with `context` unchanged lines around each change; a run of unchanged lines between them
 * becomes { kind: 'gap', skipped }.
 */
export function hunks(rows, context = 3) {
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => {
    if (r.kind === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = 1;
  });
  const out = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'gap', skipped });
      skipped = 0;
      out.push(r);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: 'gap', skipped });
  return out;
}
