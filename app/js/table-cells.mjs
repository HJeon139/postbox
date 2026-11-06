// How a table block shows one cell’s value. Moved out of app/js/blocks.mjs.

export function fmtCell(v, _col) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
