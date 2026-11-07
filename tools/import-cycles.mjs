// The import cycles in Postbox’s own modules (#312): each strongly connected component of the static import graph, so
// a test can hold them to a recorded list that only shrinks (tests/import-cycles-scc.test.mjs). Biome’s noImportCycles
// fails a new cycle in any other file; this sees one that grows a cycle a file is already allowed to be in.
//
// Static imports only: `import … from`, `import '…'` and `export … from`. A dynamic import() isn’t an edge: it loads
// its module only when its line runs, once the module running it has loaded with all it imports statically, so it
// can’t cause the load-order bug a cycle can, a value used before it’s set (designs/developing.md, “Modules”).
//
//   node tools/import-cycles.mjs        prints each cycle, its files and the edges inside it

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The folders with Postbox’s modules: what runs in the server, the page and the tools. */
export const DIRS = ['bin', 'server', 'shared', 'app/js', 'tools'];
const STATIC = /(?:^|\n)\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

/** Every .mjs and .js file under dirs, but a vendor folder’s. @param {string} root @param {string[]} dirs */
function modules(root, dirs) {
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (n === 'vendor' || n === 'node_modules') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.m?js$/.test(n)) out.push(p);
    }
  };
  for (const d of dirs) if (existsSync(join(root, d))) walk(join(root, d));
  return out;
}

/**
 * The static import graph: each file, relative to root, and the files it imports. A path from the root (`/shared/…`,
 * as the page imports) resolves under root; a package or a file that isn’t there is no edge.
 * @param {string} root @param {string[]} [dirs]
 * @returns {Map<string, Set<string>>}
 */
export function importGraph(root, dirs = DIRS) {
  const graph = new Map();
  for (const f of modules(root, dirs)) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const out = new Set();
    for (const m of src.matchAll(STATIC)) {
      const spec = m[1] ?? m[2];
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      const to = spec.startsWith('/') ? join(root, spec) : resolve(dirname(f), spec);
      if (existsSync(to)) out.add(relative(root, to));
    }
    graph.set(relative(root, f), out);
  }
  return graph;
}

/**
 * The cycles: each strongly connected component of more than one file, or a file that imports itself, as its files
 * sorted, and the list sorted by its first file (Tarjan’s algorithm).
 * @param {Map<string, Set<string>>} graph
 * @returns {string[][]}
 */
export function importCycles(graph) {
  let next = 0;
  const stack = [];
  const onStack = new Set();
  const index = new Map();
  const low = new Map();
  const found = [];
  const visit = (/** @type {string} */ v) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const c = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      c.push(w);
    } while (w !== v);
    if (c.length > 1 || graph.get(v)?.has(v)) found.push(c.sort());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found.sort((a, b) => a[0].localeCompare(b[0]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const graph = importGraph(ROOT);
  const cycles = importCycles(graph);
  console.log(`${cycles.length} import cycles in ${graph.size} modules`);
  for (const c of cycles) {
    console.log(`\n${c.length} files:`);
    for (const f of c) console.log(`  ${f} -> ${[...(graph.get(f) ?? [])].filter((t) => c.includes(t)).join(', ')}`);
  }
}
