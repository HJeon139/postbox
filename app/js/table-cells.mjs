// How a table block shows one cell’s value. Moved out of app/js/blocks.mjs.

// A column named for a year or an id: its whole numbers are names, not amounts, so 2023 never reads “2,023” (#836).
// The singular name anywhere is a name (“Year”, “Fiscal year”, “Year founded”, “ID number”), and so is the plural at
// the end (“IDs”). The plural with words after it (“IDs found”, “Years active”), or a name after “per”, “by”, “of” and
// the like (“Revenue per year”, “Count of IDs”), is an amount, which keeps its separators (#844). A label that names
// none of these leaves it to the column’s id, as in { id: 'year', label: 'FY' }.
const NAME = /(?:^|\s)(?:year|yr|id)(?=\s|$)/i;
const PLURAL_LAST = /(?:^|\s)(?:years|ids)$/i;
const MENTION = /(?:^|\s)(?:years?|yr|ids?)(?=\s|$)/i;
const AMOUNT_OF_NAME = /(?:^|\s)(?:per|by|of|a|an|each|every|in|for)\s+(?:years?|yr|ids?)(?=\s|$)/i;

/** Words, split at spaces, `_`, `-` and camelCase (“paperId” is “paper Id”), with a note or punctuation after them
 * dropped, since it doesn’t change what they name: “Year (FY)”, “Year:”, “ID #”. @param {string} s */
const wordsOf = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[\s:#*.]+$/, '')
    .trim();

/** Whether these words name a year or an id. @param {string} words */
const names = (words) => !AMOUNT_OF_NAME.test(words) && (NAME.test(words) || PLURAL_LAST.test(words));

/** @param {{ id?: string, label?: string } | undefined} col */
function namesYearOrId(col) {
  const label = wordsOf(col?.label ?? '');
  // “Revenue (per year)” mentions a year only inside its note, so the note counts as saying it.
  if (MENTION.test(label) || MENTION.test(col?.label ?? '')) return names(wordsOf((col?.label ?? '').replace(/[()]/g, ' ')));
  return names(wordsOf(col?.id ?? ''));
}

/** @param {unknown} v @param {{ id?: string, label?: string } | undefined} col */
export function fmtCell(v, col) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && Number.isInteger(v) && namesYearOrId(col)) return String(v);
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
