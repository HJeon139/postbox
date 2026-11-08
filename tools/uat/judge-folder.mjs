// A judge’s own folder (#995). The judges run on the claude CLI with Read and Grep, in the folder they’re given. In a
// run’s folder they could read its report and the customer’s verdicts, and judge from those instead of what they were
// shown. Each judge call gets a fresh folder holding only its files, removed after.

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs `fn` in a fresh folder holding only `files`, then removes the folder.
 * @template T
 * @param {Record<string, string>} files  the name each file has there → where it is
 * @param {(cwd: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function inOwnFolder(files, fn) {
  const cwd = mkdtempSync(join(tmpdir(), 'pb-judge-'));
  try {
    for (const [name, from] of Object.entries(files)) copyFileSync(from, join(cwd, name));
    return await fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
