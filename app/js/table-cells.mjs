// How a table block shows one cell’s value. Moved out of app/js/blocks.mjs.

// A column named for a year or an id: its whole numbers are names, not amounts, so 2023 never reads “2,023” (#836).
const NAMES = /\b(?:years?|yr|id|ids)\b/i;

/** @param {unknown} v @param {{ id?: string, label?: string } | undefined} col */
export function fmtCell(v, col) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && Number.isInteger(v) && NAMES.test(`${col?.label ?? ''} ${col?.id ?? ''}`)) return String(v);
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
