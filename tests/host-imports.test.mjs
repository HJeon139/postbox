// Host code ships to a remote host without the server (#120), so it can import only node: modules and shared/.
// This follows every static import and export … from, transitively, starting from the tool list the host’s shim
// serves (shared/mcp-tools.mjs), the protocol (shared/remote-protocol.mjs) and every regular file under
// server/remote/host/, whatever its name: the `host` program ssh runs has no extension, so files are taken as JavaScript
// by what they contain, and every one is read and scanned, even one that turns out to import nothing.
// shared/catalog.mjs imports ./urls.mjs, so checking only the first level would miss a file. It fails on a file outside
// shared/ or server/remote/host/, on a bare package import, on anything under the folder that isn’t a regular file or a
// folder (a symlink could lead anywhere), and on finding nothing to check, so it can’t pass while checking nothing.

import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = join(ROOT, 'server', 'remote', 'host');
const ALLOWED = [join(ROOT, 'shared') + sep, HOST + sep];

// A static import or re-export at the start of a line: import '…', import … from '…', export * from '…' or
// export { … } from '…'. The names between may span lines. Comments start with // or *, so one isn’t matched.
const SPECIFIERS = /^\s*(?:import\s*(?:[\w$*{}\s,]+?\s*from\s*)?|export\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*)['"]([^'"]+)['"]/gm;

/**
 * Every regular file under a folder, if it exists, with or without an extension. Anything else but a folder is a
 * problem, since the host would run whatever it leads to.
 * @param {string} dir @param {string[]} problems
 */
function filesUnder(dir, problems) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, f);
    const st = lstatSync(path);
    if (st.isFile()) files.push(path);
    else if (!st.isDirectory()) problems.push(`${relative(ROOT, path)} isn’t a regular file or a folder`);
  }
  return files;
}

test('host code imports only node: modules and shared/, transitively', (t) => {
  const problems = [];
  const queue = [join(ROOT, 'shared', 'mcp-tools.mjs'), join(ROOT, 'shared', 'remote-protocol.mjs'), ...filesUnder(HOST, problems)];
  const checked = new Set();
  while (queue.length) {
    const file = /** @type {string} */ (queue.shift());
    if (checked.has(file)) continue;
    checked.add(file);
    const rel = relative(ROOT, file);
    if (!ALLOWED.some((dir) => file.startsWith(dir))) {
      problems.push(`${rel} is outside shared/ and server/remote/host/`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`${rel} doesn’t exist`);
      continue;
    }
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIERS)) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) queue.push(resolve(dirname(file), spec));
      else problems.push(`${rel} imports the package “${spec}”`);
    }
  }
  const files = [...checked].map((f) => relative(ROOT, f)).sort();
  t.diagnostic(`checked ${files.length} files: ${files.join(', ')}`);
  assert.ok(files.length > 0, 'found no host files to check');
  assert.deepEqual(problems, []);
});
