// Code spans, read as the renderer reads them (markdown-inline.mjs), for the readers that set code apart without
// rendering: plain text, mentions, the glossary lint and the disclosure parser (#1601).

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
 * One line with each code span replaced by `fn(code, span)`, read left to right (codeSpanAt).
 * @param {string} line @param {(code: string, span: string) => string} fn
 */
function mapLine(line, fn) {
  if (!line.includes('`')) return line;
  const longest = longestRunFrom(line);
  let out = '';
  let i = 0;
  for (let at = line.indexOf('`'); at > -1; at = line.indexOf('`', i)) {
    const { code, end } = codeSpanAt(line, at, longest);
    out += line.slice(i, at) + (code === null ? line.slice(at, end) : fn(code, line.slice(at, end)));
    i = end;
  }
  return out + line.slice(i);
}

/**
 * The text with each code span replaced by `fn(code, span)`. A span never crosses a line, since the renderer reads one
 * line at a time: a stray run on one line leaves the next one’s prose as prose (#1601). A line ends where the renderer
 * ends one (markdown.mjs), at \n, \r\n or a lone \r, and the breaks are kept as they were.
 * @param {string} s @param {(code: string, span: string) => string} fn
 */
export function mapCodeSpans(s, fn) {
  // Most messages have no backticks, and mentions are read on every keystroke and every item in a catch-up.
  if (!s.includes('`')) return s;
  return s
    .split(/(\r\n?|\n)/)
    .map((part, i) => (i % 2 ? part : mapLine(part, fn)))
    .join('');
}
