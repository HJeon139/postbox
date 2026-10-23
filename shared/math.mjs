// Math in Markdown: where inline math ends. Moved out of markdown.mjs, which draws it.

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
