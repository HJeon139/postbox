// Code spans, read as the renderer reads them (markdown-inline.mjs), for the readers that set code apart without
// rendering: plain text, mentions, the glossary lint and the disclosure parser (#1601).

/**
 * The longest run of backticks that starts at or after each place in s, so a run with no close of its length is known
 * at once: an open run of n backticks can close only where n of them come later. Kept linear on the server, where a
 * block’s fallback of 200,000 characters is cut to plain text (#793).
 */
function longestRunFrom(s) {
  const run = new Int32Array(s.length + 1);
  const longest = new Int32Array(s.length + 1);
  for (let i = s.length - 1; i >= 0; i--) {
    run[i] = s[i] === '`' ? run[i + 1] + 1 : 0;
    longest[i] = Math.max(run[i], longest[i + 1]);
  }
  return longest;
}

/**
 * The text with each code span replaced by `fn(code, span)`, read left to right: a run of backticks closes at the next
 * same run, even inside a longer one, and its code drops one space each side; a run with no close is text.
 * @param {string} s @param {(code: string, span: string) => string} fn
 */
export function mapCodeSpans(s, fn) {
  const longest = longestRunFrom(s);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('`', i);
    if (at < 0) break;
    const run = /** @type {RegExpMatchArray} */ (s.slice(at).match(/^`+/))[0];
    const end = longest[at + run.length] >= run.length ? s.indexOf(run, at + run.length) : -1;
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
