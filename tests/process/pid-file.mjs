// A pid that a test’s child process writes to a file (#2012). The write creates the file before it holds the pid, so
// a read that waits only for the file can find it empty, and `Number('')` is 0: a signal to pid 0 reaches the test’s
// own process group, the test runner included. These read a pid only once the file holds a whole positive number.

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * The pid in `file`, or null while it doesn’t hold a whole positive number: missing, empty, or anything else.
 * @param {string} file @returns {number | null}
 */
export function pidIn(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null; // not written yet
  }
  return /^\s*[1-9]\d*\s*$/.test(text) ? Number(text) : null;
}

/**
 * The pid in `file` once it holds one, within `ms`, looking once more at the deadline.
 * @param {string} file @param {number} ms @param {number} [every]  ms between looks
 */
export async function pidWithin(file, ms, every = 50) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const pid = pidIn(file);
    if (pid) return pid;
  }
  const pid = pidIn(file);
  if (pid) return pid;
  throw new Error(`No pid was written to ${file} within ${ms} ms.`);
}
