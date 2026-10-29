// Comparing the x.y.z versions CLIs report, such as Claude Code’s “2.1.310 (Claude Code)”.

/** a < b, for x.y.z versions; null if either has no x.y.z. @param {string} a @param {string} b */
export function olderThan(a, b) {
  const parts = (v) => /(\d+)\.(\d+)\.(\d+)/.exec(String(v))?.slice(1).map(Number) ?? null;
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
}
