// Step 2 of tools/signoff.mjs (#845): every Node major CI runs is installed here, so the gate can run on the one CI
// uses. The majors come from the workflows themselves, each `node-version:` in .github/workflows/*.yml, following a
// `${{ matrix.<key> }}` to that key’s values (a flow list, a block list, or matrix.include’s entries), so a new major in
// CI is a new requirement here with no list of our own. A node-version this can’t read a major from fails step 2.
//
// A major is found, in order: a path given with --node; the Node running this script; then the newest install of it
// under nvm, fnm, mise or Volta, or Homebrew’s node@<major>. Each candidate is asked its version, so a stale link or
// a wrong path doesn’t count. These are the places designs/remote-hosts.md, “Node 22 or later there”, looks too.

import { join } from 'node:path';
import { exec } from './wait.mjs';

const WORKFLOWS = '.github/workflows';

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

/** Version folder names, newest first: v22.9.0 before v22.10.0 is wrong, so compare as numbers. @param {string[]} names */
const newestFirst = (names) => [...names].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));

/**
 * Where an install of major may be, newest first in each manager.
 * @param {import('./deps.mjs').Deps} d @param {number} major
 */
function candidates(d, major) {
  const h = d.home;
  /** @type {[string, RegExp, (name: string) => string][]} */
  const managers = [
    [join(h, '.nvm/versions/node'), new RegExp(`^v${major}\\.`), (n) => join(n, 'bin/node')],
    [join(h, '.local/share/fnm/node-versions'), new RegExp(`^v${major}\\.`), (n) => join(n, 'installation/bin/node')],
    [join(h, 'Library/Application Support/fnm/node-versions'), new RegExp(`^v${major}\\.`), (n) => join(n, 'installation/bin/node')],
    [join(h, '.local/share/mise/installs/node'), new RegExp(`^${major}(\\.|$)`), (n) => join(n, 'bin/node')],
    [join(h, '.volta/tools/image/node'), new RegExp(`^${major}\\.`), (n) => join(n, 'bin/node')],
  ];
  /** @type {string[]} */
  const paths = [];
  for (const [dir, match, bin] of managers) {
    if (!d.exists(dir)) continue;
    for (const name of newestFirst(d.list(dir).filter((n) => match.test(n)))) paths.push(join(dir, bin(name)));
  }
  for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) paths.push(join(prefix, `node@${major}/bin/node`));
  return paths;
}

/**
 * The first Node binary of major that answers with that major’s version, or undefined.
 * @param {import('./deps.mjs').Deps} d @param {number} major @param {string[]} given paths from --node
 * @returns {Promise<{ path: string, version: string } | undefined>}
 */
export async function findNode(d, major, given) {
  const paths = [...given, ...(majorOf(d.nodeVersion) === major ? [d.execPath] : []), ...candidates(d, major)];
  for (const path of paths) {
    if (path !== d.execPath && !d.exists(path)) continue;
    const r = await exec(d, [path, '--version']);
    if (r.code === 0 && majorOf(r.out) === major) return { path, version: r.out.trim() };
  }
  return undefined;
}

/**
 * Step 2: each major CI runs has a Node here. Returns the found ones by major, or why one is missing.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string[]} given
 */
export async function toolchain(d, root, given) {
  const majors = ciMajors(d, root);
  // No node-version found means the workflows changed shape, not that CI runs no Node.
  if (!majors.length) return { ok: false, why: `found no node-version in ${WORKFLOWS}/*.yml: has the workflows’ format changed?` };
  /** @type {Record<number, { path: string, version: string }>} */
  const found = {};
  for (const { major, from } of majors) {
    const node = await findNode(d, major, given);
    if (!node) {
      const how = `Install it (nvm install ${major}, fnm install ${major}, mise use node@${major}, or brew install node@${major}), or pass its path with --node <path>.`;
      return { ok: false, why: `Node ${major} isn’t installed: CI runs it (${from}). ${how}`, found };
    }
    found[major] = node;
  }
  const note = Object.values(found)
    .map((n) => n.version)
    .join(', ');
  return { ok: true, note: `CI runs Node ${majors.map((m) => m.major).join(' and ')}; found ${note}`, found };
}
