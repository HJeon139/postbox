// The repo’s Biome config fails an import cycle (#312): two modules that import each other can load in an order where
// one reads a value the other hasn’t set yet (designs/developing.md, “Modules”). This runs the pinned Biome, with the
// repo’s biome.json, on files laid out as the repo’s are in a temp folder, so it’s under tests/process/ (the unit tests
// can’t start processes, tests/guard.mjs). The cycles already there are in tests/import-cycles-scc.test.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../temp-dirs.mjs';

const biome = fileURLToPath(new URL('../../node_modules/@biomejs/biome/bin/biome', import.meta.url));
const home = tempDir('pb-test-lint-cycles-');
copyFileSync(fileURLToPath(new URL('../../biome.json', import.meta.url)), join(home, 'biome.json'));
// Its Grit plugins, which biome.json names by path.
cpSync(fileURLToPath(new URL('../../tools/biome', import.meta.url)), join(home, 'tools', 'biome'), { recursive: true });

/** Writes each file, then Biome’s lint of them: its exit code and what it printed. @param {Record<string, string>} files */
function lint(files) {
  for (const [path, code] of Object.entries(files)) {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, code);
  }
  const r = spawnSync(process.execPath, [biome, 'lint', ...Object.keys(files)], { cwd: home, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('#312 two server modules that import each other fail the lint, and one that only imports the other passes', () => {
  const cycle = lint({
    'server/a.mjs': "import { b } from './b.mjs';\n\nexport const a = () => b;\n",
    'server/b.mjs': "import { a } from './a.mjs';\n\nexport const b = () => a;\n",
  });
  assert.equal(cycle.status, 1, cycle.out);
  assert.match(cycle.out, /noImportCycles/);
  const one = lint({
    'server/a.mjs': "import { b } from './b.mjs';\n\nexport const a = () => b;\n",
    'server/b.mjs': 'export const b = () => 1;\n',
  });
  assert.equal(one.status, 0, one.out);
});
