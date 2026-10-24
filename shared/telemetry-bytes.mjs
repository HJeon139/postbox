// A telemetry report’s bytes (designs/telemetry-persona.md, R16, R18): Postbox writes them itself from the gate’s
// output, short enough to read whole, and a line left out is the value on it taken out, never text rewritten.

import { bucket, cost, duration } from './telemetry-vocab.mjs';

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

/** The lines that say what the report is: never left out. */
const KEEP = new Set(['schema', 'id']);

/** Numbers kept exact: an issue number, and the entropy (a measure, not a count). */
const EXACT = new Set(['issue', 'initiativeEntropy']);

/**
 * The collector’s numbers, in buckets (R12): a duration (a field ending in Ms) as under 1 s, seconds or minutes; a cost
 * in cents to the nearest power of ten; every other count, size or token total in log buckets. So an exact number can’t
 * identify a change or carry a value. Issue numbers stay; the entropy is rounded to a tenth.
 */
export function blurred(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => blurred(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blurred(x, k)]));
  if (typeof v !== 'number') return v;
  if (key === 'initiativeEntropy') return Math.round(v * 10) / 10;
  if (EXACT.has(key)) return v;
  if (key.endsWith('Ms')) return duration(v);
  if (key === 'costUsd') return cost(v);
  return bucket(v);
}

/** A value on one line, as JSON with a space after each colon and comma, so a long one wraps where it can. */
const oneLine = (x) => JSON.stringify(x).replace(/("(?:[^"\\]|\\.)*")|([,:])/g, (_m, str, p) => str ?? `${p} `);

/**
 * The report’s JSON as it’s shown and saved: each top-level value and each field of a top-level object on a line of its
 * own, and each item of a list on one line (a turn, an agent, a check). Each line has the path of the value it shows:
 * what leaving it out removes. A line that only opens or closes an object or a list, or names the schema or id, is
 * fixed: it has no Leave out (R18).
 * @param {any} v
 * @returns {{ text: string, paths: (string|number)[][], fixed: Set<number> }}  fixed: 0-based line indexes
 */
export function jsonLines(v) {
  /** @type {string[]} */
  const lines = [];
  /** @type {(string|number)[][]} */
  const paths = [];
  const fixed = new Set();
  const put = (text, path, only = false) => {
    if (only || (path.length === 1 && KEEP.has(String(path[0])))) fixed.add(lines.length);
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
    put(`${pad}${head}${open}`, path, true);
    for (const [i, [k, y]] of kids.entries())
      walk(y, [...path, k], `${pad}  `, Array.isArray(x) ? '' : `${JSON.stringify(k)}: `, i < kids.length - 1 ? ',' : '');
    put(`${pad}${close}${tail}`, path, true);
  };
  walk(v, [], '', '', '');
  return { text: lines.join('\n'), paths, fixed };
}

/**
 * The report less the values on these lines (1-based) of its bytes: Leave out. A fixed line removes nothing.
 * @param {any} report @param {number[]} lineNumbers
 */
export function leaveOut(report, lineNumbers) {
  const { paths, fixed } = jsonLines(report);
  const out = structuredClone(report);
  const targets = [
    ...new Set(
      lineNumbers
        .filter((n) => !fixed.has(n - 1))
        .map((n) => paths[n - 1])
        .filter((p) => p?.length)
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
