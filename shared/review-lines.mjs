// Groups a Markdown review's lines into the blocks renderMarkdown would see, so a table, list, fence or
// quote renders as a whole while each line keeps a comment target of its own. It follows the block
// rules in markdown.mjs, in the same order. In a diff, it runs on diffLines' output, so a removed
// table row is still a row of that table, shown as removed.

import { closesFence, FENCE, HEADING, LIST_ITEM, MATH, QUOTE, RULE, TABLE_SEP } from './markdown.mjs';

/**
 * A source line. n is its line number in the current version, o in the previous one (diffs only).
 * @typedef {{ t: string, kind: 'same' | 'add' | 'del', n?: number, o?: number }} Row
 *
 * A comment target: a line, a table row, a list item (with its continuation lines) or a code line.
 * key is the line its comments go on, or null for a removed one; lines are every current line in it,
 * so a comment on any of them shows here. kind is 'mod' for an item whose continuation lines changed.
 * @typedef {{ key: number | null, lines: number[], kind: 'same' | 'add' | 'del' | 'mod', rows: Row[] }} Unit
 *
 * depth is how many quotes the group is inside. Table and list units are in the order their rows and
 * items render (tr and li in document order). hidden rows render as nothing: a table's delimiter
 * row, a fence's markers, and the old text of a list item's changed continuation line. rows are all
 * of a table's or list's rows, in order, for drawing it line by line if it doesn't render as expected.
 * @typedef {{ type: 'line', depth: number, unit: Unit }
 *   | { type: 'code', depth: number, lang: string, units: Unit[], hidden: Row[] }
 *   | { type: 'table' | 'list', depth: number, source: string, units: Unit[], hidden: Row[], rows: Row[] }} Group
 */

/**
 * @param {Row[]} rows
 * @param {number} [depth]
 * @returns {Group[]}
 */
export function groupReviewLines(rows, depth = 0) {
  /** @type {Group[]} */
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].t;

    const fence = t.match(FENCE);
    if (fence || MATH.test(t)) {
      const closes = fence ? (l) => closesFence(fence[1], l) : (l) => MATH.test(l);
      const body = [];
      const hidden = [rows[i]];
      for (i++; i < rows.length; i++) {
        if (closes(rows[i].t)) {
          hidden.push(rows[i]);
          break;
        }
        body.push(rows[i]);
      }
      out.push({ type: 'code', depth, lang: fence ? fence[2].toLowerCase() : 'math', units: body.map(rowUnit), hidden });
      continue;
    }

    if (QUOTE.test(t)) {
      const inner = [];
      for (; i < rows.length && QUOTE.test(rows[i].t); i++) inner.push({ ...rows[i], t: rows[i].t.match(QUOTE)?.[1] ?? '' });
      i--;
      out.push(...groupReviewLines(inner, depth + 1));
      continue;
    }

    if (!RULE.test(t) && LIST_ITEM.test(t)) {
      const body = [];
      for (; i < rows.length; i++) {
        const l = rows[i].t;
        // The same loop as renderMarkdown's list: a blank line ends the list unless the next line
        // continues it, and any other line continues the item before it.
        if (!l.trim()) {
          const next = rows[i + 1]?.t;
          if (next !== undefined && (LIST_ITEM.test(next) || /^\s{2,}\S/.test(next))) {
            body.push(rows[i]);
            continue;
          }
          break;
        }
        body.push(rows[i]);
      }
      i--;
      out.push(listGroup(body, depth));
      continue;
    }

    const sep = HEADING.test(t) || RULE.test(t) ? -1 : delimiterAfter(rows, i);
    if (sep > -1) {
      const start = i;
      const body = rows.slice(i, sep + 1);
      for (i = sep + 1; i < rows.length && rows[i].t.includes('|') && rows[i].t.trim(); i++) body.push(rows[i]);
      i--;
      out.push(tableGroup(body, sep - start, depth));
      continue;
    }

    out.push({ type: 'line', depth, unit: rowUnit(rows[i]) });
  }
  return out;
}

/**
 * A row as a target of its own: how code reviews, and lines outside any block, are commented.
 * @param {Row} r
 * @returns {Unit}
 */
export function rowUnit(r) {
  const n = r.kind === 'del' ? undefined : r.n;
  return { key: n ?? null, lines: n === undefined ? [] : [n], kind: r.kind, rows: [r] };
}

// A table starts at a row with a pipe and a delimiter row after it; this returns the delimiter's
// index, or -1. In a diff, a changed header shows as its old and new rows before the delimiter.
/**
 * @param {Row[]} rows
 * @param {number} i
 */
function delimiterAfter(rows, i) {
  if (!rows[i].t.includes('|')) return -1;
  let j = i + 1;
  if (rows[i].kind !== 'same') while (j < rows.length && rows[j].kind !== 'same' && rows[j].t.includes('|') && !TABLE_SEP.test(rows[j].t)) j++;
  return j < rows.length && TABLE_SEP.test(rows[j].t) ? j : -1;
}

// The first row heads the table and the delimiter follows it, whatever the diff put between them;
// every other row is a body row, in order. A diff that changed the delimiter has two, and the second
// is hidden too. Without a diff, a later row of dashes is content, as in renderMarkdown.
/**
 * @param {Row[]} rows
 * @param {number} sep
 * @param {number} depth
 * @returns {Group}
 */
function tableGroup(rows, sep, depth) {
  const changed = rows[sep].kind !== 'same';
  const hidden = rows.filter((r, k) => k === sep || (k > sep && changed && r.kind !== 'same' && TABLE_SEP.test(r.t)));
  const shown = rows.filter((r) => !hidden.includes(r));
  const source = [shown[0], rows[sep], ...shown.slice(1)].map((r) => r.t).join('\n');
  return { type: 'table', depth, source, units: shown.map(rowUnit), hidden, rows };
}

// One unit per item line, in the order the items render; blank and continuation lines belong to the
// item above them. In a diff, an item whose continuation lines changed shows its new text, marked as
// changed, and the old lines are hidden.
/**
 * @param {Row[]} rows
 * @param {number} depth
 * @returns {Group}
 */
function listGroup(rows, depth) {
  /** @type {Unit[]} */
  const units = [];
  /** @type {Row[]} */
  const hidden = [];
  for (const r of rows) {
    const item = LIST_ITEM.test(r.t);
    const unit = units.at(-1);
    if (item || !unit) {
      units.push(rowUnit(r));
      continue;
    }
    if (r.kind === 'del' && unit.kind !== 'del') {
      hidden.push(r);
      if (unit.kind === 'same') unit.kind = 'mod';
      continue;
    }
    unit.rows.push(r);
    if (r.kind !== 'del' && r.n !== undefined) unit.lines.push(r.n);
    if (r.kind === 'add' && unit.kind === 'same') unit.kind = 'mod';
  }
  const source = rows
    .filter((r) => !hidden.includes(r))
    .map((r) => r.t)
    .join('\n');
  return { type: 'list', depth, source, units, hidden, rows };
}
