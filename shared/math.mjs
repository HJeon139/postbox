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

/**
 * Display math starting at lines[i]: `$$` on lines of their own around it, or `$$…$$` alone on one line, as agents
 * write a formula more often than not (#147). An unclosed block runs to the end, as a streaming one does.
 * @param {string[]} lines @param {number} i
 * @returns {{ tex: string, end: number } | null}  end: the index of its last line
 */
export function displayMath(lines, i) {
  const one = lines[i].match(/^ {0,3}\$\$((?:(?!\$\$).)+)\$\$\s*$/);
  if (one?.[1].trim()) return { tex: one[1], end: i };
  if (!MATH.test(lines[i])) return null;
  let end = i + 1;
  while (end < lines.length && !MATH.test(lines[end])) end++;
  return { tex: lines.slice(i + 1, end).join('\n'), end };
}

/**
 * The math that starts at s[i], as the inline parser reads it: `$$…$$` is display math, as agents write a formula
 * on one line (#147), and `$…$` is inline math.
 * @param {string} s @param {number} i
 * @returns {{ tex: string, display: boolean, end: number } | null}  end: the index after its closing delimiter
 */
export function mathAt(s, i) {
  if (s.startsWith('$$', i)) {
    const end = s.indexOf('$$', i + 2);
    return end > -1 && s.slice(i + 2, end).trim() ? { tex: s.slice(i + 2, end), display: true, end: end + 2 } : null;
  }
  if (s[i] !== '$' || !s[i + 1] || /\s/.test(s[i + 1])) return null;
  const end = findMathEnd(s, i + 1);
  return end > -1 ? { tex: s.slice(i + 1, end), display: false, end: end + 1 } : null;
}
