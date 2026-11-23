// Code spans, read as the renderer reads them (markdown-inline.mjs, markdown.mjs), for the readers that set code apart
// without rendering: plain text, mentions, the glossary lint, the disclosure parser (#1601), the raw-HTML lint, write
// intent and room links (#1659). An escaped character is text, and a table row's cells are read one at a time.

/** What the renderer reads as escaped after a backslash (markdown-inline.mjs, inline): the pair is text. */
const ESCAPED = /[\\`*_{}[\]()#+\-.!|$~>@]/;
/** A table's separator row, as the renderer reads it (markdown.mjs, TABLE_SEP). */
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * The longest run of backticks that starts at or after each place in s, so a run with no close of its length is known
 * at once: an open run of n backticks can close only where n of them come later. Kept linear on the server, where a
 * block’s fallback of 200,000 characters is cut to plain text (#793).
 */
export function longestRunFrom(s) {
  const run = new Int32Array(s.length + 1);
  const longest = new Int32Array(s.length + 1);
  for (let i = s.length - 1; i >= 0; i--) {
    run[i] = s[i] === '`' ? run[i + 1] + 1 : 0;
    longest[i] = Math.max(run[i], longest[i + 1]);
  }
  return longest;
}

/**
 * The code span whose run of backticks starts at `at` in a line: its code, less one space each side, and where it ends.
 * A run closes at the next same run, even inside a longer one, and never past its line. A run with no close is text, so
 * its code is null and it ends after the run. This is the one rule the renderer (markdown-inline.mjs) and the readers
 * that set code apart without rendering share (#1601). longest, from longestRunFrom(line), skips a hopeless search.
 * @param {string} line @param {number} at @param {Int32Array} [longest]
 * @returns {{ code: string | null, end: number }}
 */
export function codeSpanAt(line, at, longest) {
  let open = at;
  while (line[open] === '`') open++;
  const run = line.slice(at, open);
  const close = longest && longest[open] < run.length ? -1 : line.indexOf(run, open);
  if (close < 0) return { code: null, end: open };
  return { code: line.slice(open, close).replace(/^ (.*) $/, '$1'), end: close + run.length };
}

/**
 * One line with each code span replaced by `fn(code, span)`, read left to right as the renderer reads it: an escaped
 * character first, so `\\`` is a backtick in the text, then a run of backticks (codeSpanAt).
 * @param {string} line @param {(code: string, span: string) => string} fn
 */
function mapLine(line, fn) {
  if (!line.includes('`')) return line;
  const longest = longestRunFrom(line);
  let out = '';
  let from = 0;
  for (let i = 0; i < line.length; ) {
    if (line[i] === '\\' && ESCAPED.test(line[i + 1] ?? '')) {
      i += 2;
      continue;
    }
    if (line[i] !== '`') {
      i++;
      continue;
    }
    const { code, end } = codeSpanAt(line, i, longest);
    if (code !== null) {
      out += line.slice(from, i) + fn(code, line.slice(i, end));
      from = end;
    }
    i = end;
  }
  return out + line.slice(from);
}

/**
 * A table row with each cell's code spans replaced: the renderer splits a row at each unescaped “|” before it reads its
 * spans (markdown.mjs, table), so a span never crosses a cell. @param {string} row @param {(code: string, span: string) => string} fn
 */
const mapRow = (row, fn) =>
  row
    .split(/(?<!\\)(\|)/)
    .map((part, i) => (i % 2 ? part : mapLine(part, fn)))
    .join('');

/**
 * The text with each code span replaced by `fn(code, span)`. A span never crosses a line, since the renderer reads one
 * line at a time: a stray run on one line leaves the next one’s prose as prose (#1601). A line ends where the renderer
 * ends one (markdown.mjs), at \n, \r\n or a lone \r, and the breaks are kept as they were.
 * @param {string} s @param {(code: string, span: string) => string} fn
 */
export function mapCodeSpans(s, fn) {
  // Most messages have no backticks, and mentions are read on every keystroke and every item in a catch-up.
  if (!s.includes('`')) return s;
  const parts = s.split(/(\r\n?|\n)/);
  // The lines of a table: a line with a “|” whose next is a separator row, then each line with a “|” after it.
  const inTable = new Set();
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i].includes('|') || !TABLE_SEP.test(parts[i + 2] ?? '')) continue;
    inTable.add(i);
    for (i += 4; i < parts.length && parts[i].includes('|') && parts[i].trim(); i += 2) inTable.add(i);
    i -= 2;
  }
  return parts
    .map((part, i) => {
      if (i % 2) return part;
      return inTable.has(i) ? mapRow(part, fn) : mapLine(part, fn);
    })
    .join('');
}

/** The code of each code span in the text, in order, as the page draws them. @param {string} s */
export function codeSpansIn(s) {
  /** @type {string[]} */
  const found = [];
  mapCodeSpans(String(s ?? ''), (code, span) => {
    found.push(code);
    return span;
  });
  return found;
}
