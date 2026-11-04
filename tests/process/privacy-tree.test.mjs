// Every committed text file passes the privacy check (#508), not only the fixtures: a check log and a prompt once held a
// real home path. It runs git to list the files, which tests/guard.mjs keeps out of the unit tests, so it’s under
// tests/process/ (npm run test:process). It reads the working tree and writes nothing.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkFilePrivacy, isBinary } from '../privacy-check.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every file git tracks, by its path from the root. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  return out.split('\0').filter(Boolean);
}

test('every committed text file is free of home paths, uids, account data, tokens and real addresses', () => {
  const failures = [];
  let checked = 0;
  for (const path of trackedFiles()) {
    // A file deleted in the working tree but not yet in the index has nothing left to leak.
    if (!existsSync(join(ROOT, path))) continue;
    const bytes = readFileSync(join(ROOT, path));
    if (isBinary(bytes)) continue;
    checked++;
    const violations = checkFilePrivacy(path, bytes.toString('utf8'));
    if (violations.length > 0) failures.push(`  - ${path}: ${violations.join('; ')}`);
  }
  assert.ok(checked > 100, `only ${checked} text files were checked, so the list of files is wrong`);
  assert.equal(failures.length, 0, `Found private data in ${failures.length} committed file(s):\n${failures.join('\n')}`);
});

/** The paths the fixtures README lists under “Synthetic fixtures”, one per “- `path`” line. */
function listedSynthetic() {
  const readme = readFileSync(join(ROOT, 'tests/fixtures/README.md'), 'utf8');
  const section = readme.split(/^## /m).find((part) => part.startsWith('Synthetic fixtures'));
  assert.ok(section, 'tests/fixtures/README.md has a “Synthetic fixtures” section');
  return [...section.matchAll(/^- `([^`]+)`/gm)].map(([, path]) => path);
}

// A fixture labelled synthetic says so on its first line, as the delivery spike’s baselines do.
const SYNTHETIC_LABEL = /^\S+\s*SYNTHETIC\b/;

test('every synthetic fixture the fixtures README lists exists, and every fixture labelled synthetic is listed', () => {
  const listed = listedSynthetic();
  const missing = listed.filter((path) => !existsSync(join(ROOT, path)));
  assert.deepEqual(missing, [], 'listed in tests/fixtures/README.md but not in the tree');
  const labelled = trackedFiles().filter((path) => {
    if (!path.startsWith('tests/fixtures/') || !existsSync(join(ROOT, path))) return false;
    const firstLine = readFileSync(join(ROOT, path), 'utf8').split('\n', 1)[0];
    return SYNTHETIC_LABEL.test(firstLine);
  });
  assert.deepEqual(
    labelled.filter((path) => !listed.includes(path)),
    [],
    'labelled synthetic but not listed in tests/fixtures/README.md',
  );
});
