// The import cycles left in Postbox’s modules (#312) are the ones recorded here, and the list only shrinks. Biome’s
// noImportCycles fails a cycle in any file but those its override in biome.json turns it off for, the files already in
// one; this test fails a file joining a cycle, two cycles joined into one, and a cycle gone that’s still listed.
//
// It counts static imports only (tools/import-cycles.mjs). A dynamic import() loads its module only when its line runs,
// after the module running it has loaded, so it can’t cause the load-order bug designs/developing.md, “Modules”, forbids
// cycles for. The one thing it can’t see is an extra import between two files already in the same cycle.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importCycles, importGraph } from '../tools/import-cycles.mjs';
import { tempDir } from './temp-dirs.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Each one a follow-up to break, as #312 says. Remove a cycle here once it’s gone, and its files from the override.
const CYCLES = [
  ['app/js/permissions.mjs', 'app/js/run-choice.mjs', 'app/js/sheets.mjs'],
  ['server/scheduled-wakes.mjs', 'server/store-outage.mjs'],
  ['server/store-commit.mjs', 'server/store-recover.mjs', 'server/store-retry.mjs', 'server/store-snapshot.mjs'],
  ['server/telemetry-sweep.mjs', 'server/telemetry.mjs'],
];

test('#312 the import cycles are the recorded ones: none new, none grown, none merged', () => {
  assert.deepEqual(importCycles(importGraph(ROOT)), CYCLES);
});

/** A folder of modules, each given as its path and its source. @param {Record<string, string>} files */
function tree(files) {
  const root = tempDir('pb-import-cycles-');
  for (const [path, src] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), src);
  }
  return root;
}

test('#312 the scan finds a cycle through import, a bare import and export from, but not through import()', () => {
  const root = tree({
    'server/a.mjs': "import { b } from './b.mjs';\nexport const a = 1;\n",
    'server/b.mjs': "export { c as b } from './c.mjs';\n",
    'server/c.mjs': "import './a.mjs';\nexport const c = 2;\n",
    'server/d.mjs': "export const d = () => import('./e.mjs');\n",
    'server/e.mjs': "import { d } from './d.mjs';\n",
    'app/js/f.mjs': "import { g } from '/app/js/g.mjs';\n",
    'app/js/g.mjs': "/* import { f } from './f.mjs'; */\nimport { f } from './f.mjs';\n",
  });
  assert.deepEqual(importCycles(importGraph(root)), [
    ['app/js/f.mjs', 'app/js/g.mjs'],
    ['server/a.mjs', 'server/b.mjs', 'server/c.mjs'],
  ]);
});

test('#312 the scan reads no import in a comment', () => {
  const root = tree({
    'server/a.mjs': "// import { b } from './b.mjs';\n/** @type {import('./b.mjs').B} */\nexport const a = 1;\n",
    'server/b.mjs': "import { a } from './a.mjs';\n",
  });
  assert.deepEqual(importCycles(importGraph(root)), []);
});
