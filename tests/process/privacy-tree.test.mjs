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
