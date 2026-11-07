// The repo’s Biome config fails a promise nothing waits on or handles: since #628 made a teardown async, 60 tests had
// gone on past it unawaited, and the gate passed them all. This runs the pinned Biome, with the repo’s biome.json, on
// files laid out as the repo’s are in a temp folder, so it’s under tests/process/ (the unit tests can’t start processes,
// tests/guard.mjs).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../temp-dirs.mjs';

const biome = fileURLToPath(new URL('../../node_modules/@biomejs/biome/bin/biome', import.meta.url));
const home = tempDir('pb-test-lint-promises-');
copyFileSync(fileURLToPath(new URL('../../biome.json', import.meta.url)), join(home, 'biome.json'));
// Its Grit plugins, which biome.json names by path.
cpSync(fileURLToPath(new URL('../../tools/biome', import.meta.url)), join(home, 'tools', 'biome'), { recursive: true });

/** Biome’s lint of `code` as the file at `path` in the repo: its exit code and what it printed. */
function lint(path, code) {
  const file = join(home, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, code);
  const r = spawnSync(process.execPath, [biome, 'lint', path], { cwd: home, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A spec whose teardown is `line`, as the remote broker specs end. */
const spec = (line) => `const h = { done: async () => {} };
export async function spec() {
  try {
    await Promise.resolve();
  } finally {
    ${line}
  }
}
`;

test('a test’s teardown left unawaited fails the lint, and awaited it passes', () => {
  const bare = lint('tests/teardown.test.mjs', spec('h.done();'));
  assert.notEqual(bare.status, 0, bare.out);
  assert.match(bare.out, /noFloatingPromises/);
  const awaited = lint('tests/teardown.test.mjs', spec('await h.done();'));
  assert.equal(awaited.status, 0, awaited.out);
});

test('in the server, a call that may reject fails the lint until it’s awaited, handled or marked void', () => {
  const record = (line) => `const write = async () => {};
export function record() {
  ${line}
}
`;
  const bare = lint('server/record.mjs', record('write();'));
  assert.notEqual(bare.status, 0, bare.out);
  assert.match(bare.out, /noFloatingPromises/);
  for (const line of ['write().catch(() => {});', 'void write();']) {
    const ok = lint('server/record.mjs', record(line));
    assert.equal(ok.status, 0, `${line}\n${ok.out}`);
  }
});
