// Code spans, read as the renderer reads them (markdown-inline.mjs), for the readers that set code apart without
// rendering: plain text, mentions, the glossary lint and the disclosure parser (#1601).

/**
 * The text with each code span replaced by `fn(code, span)`, read left to right: a run of backticks closes at the next
 * same run, even inside a longer one, and its code drops one space each side; a run with no close is text.
 * @param {string} s @param {(code: string, span: string) => string} fn
 */
export function mapCodeSpans(s, fn) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('`', i);
    if (at < 0) break;
    const run = /** @type {RegExpMatchArray} */ (s.slice(at).match(/^`+/))[0];
    const end = s.indexOf(run, at + run.length);
    out += s.slice(i, at);
    if (end < 0) {
      out += run;
      i = at + run.length;
      continue;
    }
    out += fn(s.slice(at + run.length, end).replace(/^ (.*) $/, '$1'), s.slice(at, end + run.length));
    i = end + run.length;
  }
  return out + s.slice(i);
}
