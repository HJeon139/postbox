// How a table block shows one cell’s value. Moved out of app/js/blocks.mjs.

// A column named for a year or an id: its whole numbers are names, not amounts, so 2023 never reads “2,023” (#836).
// The name must be the label’s last word, alone or after words that say which one (“Year”, “Fiscal year”, “Paper ID”).
// A word after it (“IDs found”), or “per”, “by” or “of” before it (“Revenue per year”, “Count of IDs”), makes the
// label an amount, which keeps its separators (#844).
const ENDS_IN_NAME = /(?:^|\s)(?:years?|yr|ids?)$/i;
const AMOUNT_OF_NAME = /(?:^|\s)(?:per|by|of|a|an|each|every|in|for)\s+(?:years?|yr|ids?)$/i;

/** The words a column goes by: its label, or else its id split at `_`, `-` and camelCase (“paperId” is “paper Id”).
 * @param {{ id?: string, label?: string } | undefined} col */
function columnWords(col) {
  const label = col?.label?.trim();
  if (label) return label;
  return (col?.id ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/** @param {{ id?: string, label?: string } | undefined} col */
function namesYearOrId(col) {
  // A note or punctuation after the name doesn’t change what it names: “Year (FY)”, “Year:”, “ID #”.
  const words = columnWords(col)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[\s:#*.]+$/, '');
  return ENDS_IN_NAME.test(words) && !AMOUNT_OF_NAME.test(words);
}

/** @param {unknown} v @param {{ id?: string, label?: string } | undefined} col */
export function fmtCell(v, col) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && Number.isInteger(v) && namesYearOrId(col)) return String(v);
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
