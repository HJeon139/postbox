// The Node majors CI runs, read from the workflows themselves for step 2 of tools/signoff.mjs (#845): each
// `node-version:` in .github/workflows/*.yml, following a `${{ matrix.<key> }}` to that key’s values (a flow list, a
// block list, or matrix.include’s entries), so a new major in CI is a new requirement there with no list of our own. A
// node-version this can’t read a major from throws.

import { join } from 'node:path';

export const WORKFLOWS = '.github/workflows';

/** The major of a version such as v22.11.0 or 22, or NaN. @param {string} v */
export const majorOf = (v) => Number(/^v?(\d+)/.exec(String(v).trim())?.[1] ?? Number.NaN);

/** A YAML scalar or list item without its quotes and any trailing comment. @param {string} v */
const bare = (v) =>
  v
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');

/** The items of a flow list (`[22, 24]`), or the one value that isn’t a list. @param {string} v */
const flowItems = (v) =>
  v
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(bare);

/**
 * The list items after line i, as a block list writes them (`- 22` on lines of their own), at indent or deeper.
 * @param {string[]} lines @param {number} i @param {number} indent
 */
function blockItems(lines, i, indent) {
  /** @type {string[]} */
  const items = [];
  for (const l of lines.slice(i + 1)) {
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const m = /^(\s*)-\s+(.*)$/.exec(l);
    if (!m || m[1].length < indent) break;
    items.push(bare(m[2]));
  }
  return items;
}

const indentOf = (/** @type {string} */ l) => l.length - l.trimStart().length;
const meaningful = (/** @type {string} */ l) => Boolean(l.trim()) && !l.trim().startsWith('#');

/**
 * A line’s key and value, as `key: value` or a list entry’s first `- key: value` writes it, with the key’s column.
 * @param {string} line
 */
function keyOf(line) {
  const m = /^(\s*(?:-\s+)?)([\w-]+):(?:\s+(.*))?$/.exec(line);
  return m ? { column: m[1].length, key: m[2], value: bare(m[3] ?? '') } : undefined;
}

/**
 * The lines line i opens as a YAML block, by indent: from i + 1 up to the first meaningful line no deeper than line i.
 * @param {string[]} lines @param {number} i @returns {number[]} their indexes, meaningful ones only
 */
function blockOf(lines, i) {
  /** @type {number[]} */
  const block = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (!meaningful(lines[j])) continue;
    if (indentOf(lines[j]) <= indentOf(lines[i])) break;
    block.push(j);
  }
  return block;
}

/** The lines of a block at its own first column: a mapping’s keys, not what’s nested under them. @param {string[]} lines @param {number[]} block */
const ownKeys = (lines, block) => {
  const column = block.length ? keyOf(lines[block[0]])?.column : undefined;
  return block.flatMap((j) => {
    const kv = keyOf(lines[j]);
    return kv && kv.column === column ? [{ ...kv, at: j }] : [];
  });
};

/**
 * The values a key gives: a flow list (`node: [22, 24]`), one value, or the block list under it (`- 22` lines).
 * @param {string[]} lines @param {{ at: number, column: number, value: string }} kv
 */
function valuesOf(lines, kv) {
  if (kv.value.startsWith('[')) return flowItems(kv.value);
  if (kv.value) return [kv.value];
  return blockItems(lines, kv.at, kv.column);
}

/**
 * The job line i is in, as its key, or undefined outside `jobs:`.
 * @param {string[]} lines @param {number} i
 */
function jobOf(lines, i) {
  const jobsAt = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (jobsAt < 0) return undefined;
  return ownKeys(lines, blockOf(lines, jobsAt))
    .filter((job) => job.at < i)
    .at(-1);
}

/**
 * Every value matrix key has for the step at line i, read only from its job’s `strategy.matrix` block: the key as one
 * of the matrix’s own, or in each of matrix.include’s entries (`- node: 22`). An exclude only removes combinations, so
 * it never lowers what CI runs. Throws why there are none.
 * @param {string[]} lines @param {number} i @param {string} key
 * @returns {string[]}
 */
function matrixValues(lines, i, key) {
  const job = jobOf(lines, i);
  const scope = job ? blockOf(lines, job.at) : lines.map((_, j) => j);
  const at = scope.find((j) => /^\s*matrix:\s*(#.*)?$/.test(lines[j]));
  if (at === undefined) throw new Error(`${job ? `job ${job.key}` : 'the workflow'} has no strategy.matrix block this script reads`);
  /** @type {string[]} */
  const values = [];
  for (const kv of ownKeys(lines, blockOf(lines, at))) {
    if (kv.key === key) values.push(...valuesOf(lines, kv));
    if (kv.key !== 'include') continue;
    for (const entry of ownKeys(lines, blockOf(lines, kv.at))) if (entry.key === key) values.push(...valuesOf(lines, entry));
  }
  if (!values.length) throw new Error(`matrix.${key} lists none this script can read`);
  return values;
}

/**
 * The Node majors one workflow’s text names, in node-version keys and the matrix values they point at. Any value
 * that isn’t a major throws, as a node-version-file does: CI runs some Node there, and leaving it out would sign off
 * without it.
 * @param {string} text
 * @returns {number[]}
 */
export function majorsIn(text) {
  const lines = text.split('\n');
  /** @type {number[]} */
  const found = [];
  lines.forEach((line, i) => {
    const kv = keyOf(line);
    if (kv?.key === 'node-version-file') throw new Error(`node-version-file: ${kv.value} isn’t read by this script: name the major in node-version`);
    if (kv?.key !== 'node-version') return;
    const key = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(kv.value)?.[1];
    let items;
    try {
      items = key ? matrixValues(lines, i, key) : flowItems(kv.value);
    } catch (e) {
      throw new Error(`node-version: ${kv.value} names no Node major: ${e.message}`);
    }
    for (const item of items) {
      if (!Number.isInteger(majorOf(item))) {
        throw new Error(`node-version: ${kv.value} names ${item}${key ? ` (matrix.${key})` : ''}, which isn’t a Node major this script can read`);
      }
      found.push(majorOf(item));
    }
  });
  return found;
}

/**
 * Every Node major the repo’s workflows run, sorted, with the file each came from.
 * @param {import('./deps.mjs').Deps} d @param {string} root
 */
export function ciMajors(d, root) {
  /** @type {Map<number, string>} */
  const majors = new Map();
  const dir = join(root, WORKFLOWS);
  for (const name of d
    .list(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()) {
    let found;
    try {
      found = majorsIn(d.readFile(join(dir, name)));
    } catch (e) {
      throw new Error(`${WORKFLOWS}/${name}: ${e.message}`);
    }
    for (const major of found) if (!majors.has(major)) majors.set(major, `${WORKFLOWS}/${name}`);
  }
  return [...majors.entries()].sort((a, b) => a[0] - b[0]).map(([major, from]) => ({ major, from }));
}
