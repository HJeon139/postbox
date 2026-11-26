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

/**
 * Every value a matrix key has in a workflow: a flow list (`node: [22, 24]`), a block list (`node:` then `- 22` lines),
 * or one value a line, as each of matrix.include’s entries gives it (`- node: 22`).
 * @param {string} text @param {string} key
 * @returns {string[]}
 */
function matrixValues(text, key) {
  const lines = text.split('\n');
  const at = new RegExp(`^(\\s*)(?:-\\s+)?${key}:\\s*(.*)$`);
  /** @type {string[]} */
  const values = [];
  lines.forEach((l, i) => {
    const m = at.exec(l);
    if (!m) return;
    const value = bare(m[2]);
    if (value.startsWith('[')) values.push(...flowItems(value));
    else if (value) values.push(value);
    else values.push(...blockItems(lines, i, m[1].length));
  });
  return values;
}

/**
 * The Node majors one workflow’s text names, in node-version keys and the matrix values they point at. A node-version
 * that names no major throws: CI runs some Node there, and requiring none would sign off without it.
 * @param {string} text
 * @returns {number[]}
 */
export function majorsIn(text) {
  /** @type {number[]} */
  const found = [];
  for (const m of text.matchAll(/^\s*-?\s*node-version:\s*(.+)$/gm)) {
    const value = bare(m[1]);
    const key = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/.exec(value)?.[1];
    const items = key ? matrixValues(text, key) : flowItems(value);
    const majors = items.map(majorOf).filter((n) => Number.isInteger(n));
    if (!majors.length) {
      const where = key ? `: matrix.${key} lists none this script can read` : '';
      throw new Error(`node-version: ${value} names no Node major${where}`);
    }
    found.push(...majors);
  }
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
