// Temp folders a shared setup makes for tests that don’t hand it their context (#797): each is removed when the test
// file’s process exits, by a `process.on('exit')` handler, so a run leaves nothing in the temp folder (#921). Exit
// comes after every `after` the file registers, so a file’s own `after` that closes an app or stops a process still
// finds its folder, and it also comes after a top-level throw or a `process.exit()`, which skip node:test’s hooks.
// `exit` doesn’t run on a signal’s default action (SIGTERM, SIGKILL, or node:test killing a file that timed out),
// so the gate’s sweep of its run folder (tools/gate-tmp.mjs, #797) and the leftovers check (#922) still catch those.
// The package.json scripts run node --test with its default process isolation, one process per test file; under
// --test-isolation=none every file shares one process, and the folders live to the end of the suite. A folder a test
// left read-only inside one is made writable first, as the gate’s sweep does, never following a link.

import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAll } from '../tools/gate-tmp.mjs';

const made = [];

/** Removes every folder tempDir has made so far; the exit handler calls it when the test file’s process ends. */
export function removeTempDirs() {
  for (const dir of made.splice(0)) removeAll(fs, dir);
}
// Synchronous, as an exit handler must be: removeAll uses only the fs’s Sync calls.
process.on('exit', removeTempDirs);

/**
 * Makes a temp folder named from `prefix`, removed when the test file’s process exits.
 * @param {string} prefix
 * @param {string} [root] the folder to make it in, the system temp folder by default
 */
export function tempDir(prefix, root = tmpdir()) {
  const dir = mkdtempSync(join(root, prefix));
  made.push(dir);
  return dir;
}
