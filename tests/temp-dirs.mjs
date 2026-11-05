// Temp folders a shared setup makes for tests that don’t hand it their context (#797): each is removed when the test
// file ends, by node:test’s `after` at the top level, so a run leaves nothing in the temp folder. A folder a test left
// read-only inside one is made writable first, as the gate’s sweep does, never following a link.

import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { removeAll } from '../tools/gate-tmp.mjs';

const made = [];

/** Removes every folder tempDir has made so far; the top-level `after` calls it when the test file ends. */
export function removeTempDirs() {
  for (const dir of made.splice(0)) removeAll(fs, dir);
}
after(removeTempDirs);

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
