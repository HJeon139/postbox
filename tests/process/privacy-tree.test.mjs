// Every committed text file passes the privacy check (#508), not only the fixtures: a check log and a prompt once held a
// real home path. It runs git to list the files, which tests/guard.mjs keeps out of the unit tests, so it’s under
// tests/process/ (npm run test:process). It reads the working tree and writes nothing.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkFilesPrivacy } from '../../tools/privacy-check.mjs';
import { isSyntheticLabel, missingSyntheticFixtures, syntheticFixturePaths } from '../../tools/synthetic-fixtures.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every file git tracks, by its path from the root. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  return out.split('\0').filter(Boolean);
}

test('every committed text file is free of home paths, uids, account data, tokens and real addresses', () => {
  // A file deleted in the working tree but not yet in the index has nothing left to leak.
  const read = (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path)) : null);
  const { checked, findings } = checkFilesPrivacy(trackedFiles(), read);
  const failures = findings.map(({ path, violations }) => `  - ${path}: ${violations.join('; ')}`);
  assert.ok(checked > 100, `only ${checked} text files were checked, so the list of files is wrong`);
  assert.equal(failures.length, 0, `Found private data in ${failures.length} committed file(s):\n${failures.join('\n')}`);
});

test('every synthetic fixture the fixtures README lists exists, and every fixture labelled synthetic is listed', () => {
  const readme = readFileSync(join(ROOT, 'tests/fixtures/README.md'), 'utf8');
  const listed = syntheticFixturePaths(readme);
  const missing = missingSyntheticFixtures(readme, (path) => existsSync(join(ROOT, path)));
  assert.deepEqual(missing, [], 'listed in tests/fixtures/README.md but not in the tree');
  const labelled = trackedFiles().filter((path) => {
    if (!path.startsWith('tests/fixtures/') || !existsSync(join(ROOT, path))) return false;
    const firstLine = readFileSync(join(ROOT, path), 'utf8').split('\n', 1)[0];
    return isSyntheticLabel(firstLine);
  });
  assert.deepEqual(
    labelled.filter((path) => !listed.includes(path)),
    [],
    'labelled synthetic but not listed in tests/fixtures/README.md',
  );
});

// The folders tools write their output to, which designs/developing.md (“Temporary files go where they’re cleaned up”)
// says git ignores. A check log under one of them was committed once, with a real home path in it.
const OUTPUT_FOLDERS = ['screenshots/latest/', 'uat-runs/', 'check-logs/'];

test('the folders tools write to are ignored, and git tracks no file in them', () => {
  for (const folder of OUTPUT_FOLDERS) {
    const checked = spawnSync('git', ['check-ignore', '--no-index', '-q', `${folder}probe.json`], { cwd: ROOT, timeout: 10_000 });
    assert.equal(checked.status, 0, `.gitignore ignores ${folder}`);
    assert.deepEqual(
      trackedFiles().filter((path) => path.startsWith(folder)),
      [],
      `git tracks files under ${folder}`,
    );
  }
});
