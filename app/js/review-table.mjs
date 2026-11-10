// A table’s delimiter row (|---|---|) in a Markdown review’s Lines (#835). It’s a line of the draft, and an agent’s
// review_block can comment on it, so it isn’t left out: it shows as a row of its own between the header and the body,
// where it is in the draft, with its source, its line number and its comment button: after the header, or after the
// new header when a diff renamed it, so the numbers read in order (#1098). The numbers beside the table then run on
// without a gap. A delimiter a diff changed shows as its source after the table instead (review.mjs).

import { h } from './dom.mjs';

/** @typedef {import('/shared/review-lines.mjs').Unit} Unit */

/**
 * A table’s targets and their rows, in order, with its delimiter’s row added to the table after its last header row.
 * @param {Element} box  the rendered table’s box
 * @param {{ units: Unit[], sep: Unit | null, head: number }} g  the table’s group (groupReviewLines)
 * @param {Element[]} rows  the table’s rows, one for each of its units
 * @param {number} cols  how many columns the table has
 * @returns {[Unit[], Element[]]}
 */
export function withDelimiter(box, g, rows, cols) {
  if (!g.sep) return [g.units, rows];
  const row = h('tr.rv-delim', h('td.rv-src', { colspan: String(cols) }, g.sep.rows[0].t.trim()));
  const at = Math.max(1, g.head);
  const body = box.querySelector('tbody');
  if (at === 1 && body) body.prepend(row);
  else rows[at - 1].after(row);
  return [
    [...g.units.slice(0, at), g.sep, ...g.units.slice(at)],
    [...rows.slice(0, at), row, ...rows.slice(at)],
  ];
}
