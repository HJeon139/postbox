// Temp folders a shared setup makes for tests that don’t hand it their context (#797): each is removed when the test
// file ends, by node:test’s `after` at the top level, so a run leaves nothing in the temp folder.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const made = [];
after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Makes a temp folder named from `prefix`, removed when the test file ends.
 * @param {string} prefix
 * @param {string} [root] the folder to make it in, the system temp folder by default
 */
export function tempDir(prefix, root = tmpdir()) {
  const dir = mkdtempSync(join(root, prefix));
  made.push(dir);
  return dir;
}
