// Import cycles (#653): a circular import means a missing module (designs/developing.md, “Modules”). catch-up-keep.mjs
// read CATCH_UP_CHARS lazily because blocks.mjs, which sets it, imported its importers back. Not a whole-tree check,
// since other cycles exist: it pins the modules a cycle was taken out of.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm;

/** The relative modules a file imports statically, as absolute paths. @param {string} file */
const importsOf = (file) => [...readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)].map((m) => resolve(dirname(file), m[1]));

/** A path of static imports from `start` back to itself, or null when none leads there. @param {string} start */
function cycleFrom(start) {
  const seen = new Set();
  const walk = (file, path) => {
    for (const next of importsOf(file)) {
      if (next === start) return [...path, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
}

test('catch-up-keep.mjs can’t reach itself through static imports (#653)', () => {
  const cycle = cycleFrom(resolve(root, 'server/catch-up-keep.mjs'));
  assert.equal(cycle, null, `a cycle: ${cycle?.map((f) => f.slice(root.length + 1)).join(' → ')}`);
});
