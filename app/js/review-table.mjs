// A table’s delimiter row (|---|---|) in a Markdown review’s Lines (#835). It’s a line of the draft, and an agent’s
// review_block can comment on it, so it isn’t left out: it shows as a row of its own between the header and the body,
// where it is in the draft, with its source, its line number and its comment button. The numbers beside the table
// then run on without a gap. A delimiter a diff changed shows as its source after the table instead (review.mjs).

import { h } from './dom.mjs';

/** @typedef {import('/shared/review-lines.mjs').Unit} Unit */

/**
 * A table’s targets and their rows, in order, with its delimiter’s row added to the table, first in its body.
 * @param {Element} box  the rendered table’s box
 * @param {{ units: Unit[], sep: Unit | null }} g  the table’s group (groupReviewLines)
 * @param {Element[]} rows  the table’s rows, one for each of its units
 * @param {number} cols  how many columns the table has
 * @returns {[Unit[], Element[]]}
 */
export function withDelimiter(box, g, rows, cols) {
  if (!g.sep) return [g.units, rows];
  const row = h('tr.rv-delim', h('td.rv-src', { colspan: String(cols) }, g.sep.rows[0].t.trim()));
  const body = box.querySelector('tbody');
  if (body) body.prepend(row);
  else rows[0].after(row);
  return [
    [g.units[0], g.sep, ...g.units.slice(1)],
    [rows[0], row, ...rows.slice(1)],
  ];
}
