// A table block's rows in the order its sorted column asks for (blocks.mjs draws them).

import { own } from '/shared/state-assets.mjs';

/**
 * The rows sorted by the column `sort`, `dir` 1 up or -1 down, or as given when no column is sorted. A cell is read by
 * its own key only, so a column id such as “constructor” reads a missing cell, not Object’s (#1549).
 */
export function sortedRows(rows, columns, sort, dir) {
  if (!sort) return rows;
  const col = columns.find((c) => c.id === sort);
  return [...rows].sort((x, y) => {
    const [a, c] = [own(x.cells, sort), own(y.cells, sort)];
    return (col.kind === 'number' ? (+a || 0) - (+c || 0) : String(a ?? '').localeCompare(String(c ?? ''))) * dir;
  });
}
