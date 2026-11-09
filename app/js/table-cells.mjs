// How a table block shows one cell’s value. Moved out of app/js/blocks.mjs.

// A column named for a year or an id: its whole numbers are names, not amounts, so 2023 never reads “2,023” (#836).
// The name ending the label is a name (“Year”, “Fiscal year”, “Paper IDs”), and so is the singular starting it when
// no amount follows (“Year founded”, “ID number”, but not “Year-end revenue” or “ID count”). The plural with words
// after it (“IDs found”, “Years active”), or a name after “per”, “by”, “of”, a slash and the like (“Revenue per
// year”, “Revenue/year”, “Count of IDs”), is an amount, which keeps its separators (#844). A label that names none of
// these leaves it to the column’s id, as in { id: 'year', label: 'FY' }.
const SINGULAR = /^(?:year|yr|id)$/i;
const NAME = /^(?:years?|yr|ids?)$/i;
const BEFORE_AMOUNT = /^(?:per|by|of|a|an|each|every|in|for)$/i;
const AMOUNT = /^(?:counts?|totals?|sum|growth|revenue|sales|change|over|end|to|date|\d+)$/i;

/** The words of a label or id, split at anything but letters and digits and at camelCase (“paperId” is “paper Id”).
 * A slash before a name reads as “per”. A note in parentheses at the end counts only when the words before it name
 * nothing: “Years (FY)” is “Years”, while “Revenue (per year)” is “Revenue per year”. @param {string} s */
function wordsOf(s) {
  const text = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s*\/\s*(?=(?:years?|yr|ids?)\b)/gi, ' per ');
  const split = (x) => x.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const note = text.match(/^(.*?)\(([^)]*)\)[^\p{L}\p{N}]*$/u);
  if (!note) return split(text);
  const before = split(note[1]);
  return before.some((w) => NAME.test(w)) ? before : [...before, ...split(note[2])];
}

/** Whether these words name a year or an id. @param {string[]} w */
function names(w) {
  if (w.some((x, i) => i > 0 && NAME.test(x) && BEFORE_AMOUNT.test(w[i - 1]))) return false;
  if (w.length > 0 && NAME.test(w[w.length - 1])) return true;
  return SINGULAR.test(w[0] ?? '') && !w.slice(1).some((x) => AMOUNT.test(x));
}

/** @param {{ id?: string, label?: string } | undefined} col */
function namesYearOrId(col) {
  const label = wordsOf(col?.label ?? '');
  return names(label.some((w) => NAME.test(w)) ? label : wordsOf(col?.id ?? ''));
}

/** @param {unknown} v @param {{ id?: string, label?: string } | undefined} col */
export function fmtCell(v, col) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && Number.isInteger(v) && namesYearOrId(col)) return String(v);
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
