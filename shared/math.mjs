// Math in Markdown: where it starts and ends, and whether it’s display math. markdown.mjs draws it.

export function findMathEnd(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === '$') {
      // "$5 and $6" isn't math: the closing $ must follow a non-space and not be followed by a digit.
      if (/\s/.test(s[j - 1]) || /\d/.test(s[j + 1] ?? '')) return -1;
      return j;
    }
  }
  return -1;
}

/** A line of its own that opens and closes display math. */
export const MATH = /^ {0,3}\$\$\s*$/;
// LaTeX’s own delimiters, which GPT models on other backends write by default (#137): \[ on a line of its own
// opens display math, closed by \] on one, and \[…\] on one line is display math too.
const LATEX_OPEN = /^ {0,3}\\\[\s*$/;
const LATEX_CLOSE = /^ {0,3}\\\]\s*$/;

/**
 * The line that closes the display math this line opens, when it opens a block of lines: `$$`, closed by `$$`, or
 * `\[`, closed by `\]`. A `$$` block left open runs to the end, as a streaming one does. A `\[` without its `\]` in
 * the lines after it stays an escaped bracket, as before #137. The review groups lines by it too (review-lines.mjs).
 * @param {string} line @param {(string | { t: string })[]} after  the lines after it, or a review’s rows of them
 * @returns {((line: string) => boolean) | null}
 */
export function displayCloser(line, after) {
  const close = MATH.test(line) ? MATH : LATEX_OPEN.test(line) && after.some((l) => LATEX_CLOSE.test(typeof l === 'string' ? l : l.t)) ? LATEX_CLOSE : null;
  return close && ((/** @type {string} */ l) => close.test(l));
}

/**
 * Display math starting at lines[i]: a block between lines that open and close it (displayCloser), or `$$…$$` (or
 * `\[…\]`) alone on one line, as agents write a formula more often than not (#147, #137).
 * @param {string[]} lines @param {number} i
 * @returns {{ tex: string, end: number } | null}  end: the index of its last line
 */
export function displayMath(lines, i) {
  const one = lines[i].match(/^ {0,3}(?:\$\$((?:(?!\$\$).)+)\$\$|\\\[((?:(?!\\\]).)+)\\\])\s*$/);
  const tex = one?.[1] ?? one?.[2];
  if (tex?.trim()) return { tex, end: i };
  const close = displayCloser(lines[i], lines.slice(i + 1));
  if (!close) return null;
  let end = i + 1;
  while (end < lines.length && !close(lines[end])) end++;
  return { tex: lines.slice(i + 1, end).join('\n'), end };
}

/**
 * The math that starts at s[i], as the inline parser reads it: `$$…$$` is display math, as agents write a formula
 * on one line (#147), and `$…$` is inline math. So are LaTeX’s `\[…\]` and `\(…\)` (#137): read before backslash
 * escapes, so `\(` without its `\)` is still an escaped bracket.
 * @param {string} s @param {number} i
 * @returns {{ tex: string, display: boolean, end: number } | null}  end: the index after its closing delimiter
 */
export function mathAt(s, i) {
  const pair = s.startsWith('$$', i) ? '$$' : s.startsWith('\\(', i) ? '\\)' : s.startsWith('\\[', i) ? '\\]' : null;
  if (pair) {
    const end = s.indexOf(pair, i + 2);
    return end > -1 && s.slice(i + 2, end).trim() ? { tex: s.slice(i + 2, end), display: pair !== '\\)', end: end + 2 } : null;
  }
  if (s[i] !== '$' || !s[i + 1] || /\s/.test(s[i + 1])) return null;
  const end = findMathEnd(s, i + 1);
  return end > -1 ? { tex: s.slice(i + 1, end), display: false, end: end + 1 } : null;
}
