// A telemetry report’s bytes (designs/telemetry-persona.md, R16, R18): Postbox writes them itself from the gate’s
// output, short enough to read whole, and a line left out is the value on it taken out, never text rewritten.

/**
 * The report without what says nothing: null, zero, and empty lists and objects. A missing count is zero; a false
 * stays, since it says something.
 */
export function pruned(v) {
  if (Array.isArray(v)) return v.map(pruned);
  if (!v || typeof v !== 'object') return v;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const y = pruned(x);
    const empty = y === null || y === undefined || y === 0 || (typeof y === 'object' && !Object.keys(y).length);
    if (!empty) out[k] = y;
  }
  return out;
}

/** A value on one line, as JSON with a space after each colon and comma, so a long one wraps where it can. */
const oneLine = (x) => JSON.stringify(x).replace(/("(?:[^"\\]|\\.)*")|([,:])/g, (_m, str, p) => str ?? `${p} `);

/**
 * The report’s JSON as it’s shown and saved: each top-level value and each field of a top-level object on a line of its
 * own, and each item of a list on one line (a turn, an agent, a check). Each line has the path of the value it shows:
 * what leaving it out removes.
 * @param {any} v
 * @returns {{ text: string, paths: (string|number)[][] }}
 */
export function jsonLines(v) {
  /** @type {string[]} */
  const lines = [];
  /** @type {(string|number)[][]} */
  const paths = [];
  const put = (text, path) => {
    lines.push(text);
    paths.push(path);
  };
  const walk = (x, path, pad, head, tail) => {
    const kids = Array.isArray(x) ? x.map((y, i) => [i, y]) : x && typeof x === 'object' ? Object.entries(x) : null;
    // Objects open up to the second level; a list opens unless it holds only plain values.
    const spread = Array.isArray(x) ? x.some((y) => y && typeof y === 'object') : path.length < 2;
    if (!kids?.length || !spread) {
      put(`${pad}${head}${oneLine(x)}${tail}`, path);
      return;
    }
    const [open, close] = Array.isArray(x) ? ['[', ']'] : ['{', '}'];
    put(`${pad}${head}${open}`, path);
    for (const [i, [k, y]] of kids.entries())
      walk(y, [...path, k], `${pad}  `, Array.isArray(x) ? '' : `${JSON.stringify(k)}: `, i < kids.length - 1 ? ',' : '');
    put(`${pad}${close}${tail}`, path);
  };
  walk(v, [], '', '', '');
  return { text: lines.join('\n'), paths };
}

/**
 * The report less the values on these lines (1-based) of its bytes: Leave out. A line that opens or closes the whole
 * report, or names its schema or id, removes nothing.
 * @param {any} report @param {number[]} lineNumbers
 */
export function leaveOut(report, lineNumbers) {
  const { paths } = jsonLines(report);
  const out = structuredClone(report);
  const keep = new Set(['schema', 'id']);
  const targets = [
    ...new Set(
      lineNumbers
        .map((n) => paths[n - 1])
        .filter((p) => p?.length && !(p.length === 1 && keep.has(String(p[0]))))
        .map((p) => JSON.stringify(p)),
    ),
  ].map((s) => JSON.parse(s));
  // Deepest and last first, so taking one out doesn’t move another.
  targets.sort((a, b) => b.length - a.length || String(b.at(-1)).localeCompare(String(a.at(-1)), undefined, { numeric: true }));
  for (const p of targets) {
    const parent = p.slice(0, -1).reduce((o, k) => o?.[k], out);
    if (parent == null) continue;
    if (Array.isArray(parent)) parent.splice(Number(p.at(-1)), 1);
    else delete parent[p.at(-1)];
  }
  return pruned(out);
}
