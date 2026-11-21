// Removing the config folder a test gave a model listing (#1562). Something the CLI started can still write there after
// the CLI closed: seen once under a full run’s load, never alone. So the removal retries, and when it had to, the
// test’s diagnostics say what was there: each file left, with how long after the CLI closed it last changed, and each
// process with a file open in the folder (lsof +D: macOS ps shows no other process’s environment, so naming the folder
// there finds nothing). Only a folder that can’t be removed at all fails the test.

import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** When a file last changed, from the CLI’s close. @param {number | undefined} at @param {number | undefined} closedAt */
function changed(at, closedAt) {
  if (at === undefined) return 'gone';
  if (closedAt === undefined) return 'the CLI never closed';
  return `+${Math.round(at - closedAt)} ms`;
}

/**
 * Each process with a file open under dir, as “pid command”, from lsof’s field output (p and c lines); none when lsof
 * finds none, or isn’t there. @param {string} dir @returns {string[]}
 */
export function holders(dir) {
  const out = spawnSync('lsof', ['-n', '-F', 'pc', '+D', dir], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '';
  /** @type {string[]} */
  const found = [];
  let pid = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('c') && pid && Number(pid) !== process.pid) found.push(`${pid} ${line.slice(1)}`);
  }
  return found;
}

/** What’s in the folder: its files with their times, and the processes holding any of them. @param {string} dir @param {number | undefined} closedAt */
export function writers(dir, closedAt) {
  const left = (/** @type {string} */ d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return [`${relative(dir, d)}/ (gone)`];
    }
    return entries.flatMap((f) => {
      const p = join(d, f.name);
      if (f.isDirectory()) return left(p);
      return [`${relative(dir, p)} (${changed(statSync(p, { throwIfNoEntry: false })?.mtimeMs, closedAt)})`];
    });
  };
  return `files: ${left(dir).join(', ') || 'none'}; processes: ${holders(dir).join(' | ') || 'none'}`;
}

/**
 * Removes the listing’s folder, retrying when the first try fails, and records what was there then as a diagnostic.
 * @param {import('node:test').TestContext} t @param {string} dir @param {number | undefined} closedAt
 */
export function removeListing(t, dir, closedAt) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    t.diagnostic(`#1562: the listing’s folder was still being written after the CLI closed, so its removal retried. ${writers(dir, closedAt)}`);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch (again) {
      throw new Error(`Couldn’t remove the listing’s folder: ${writers(dir, closedAt)}`, { cause: new AggregateError([e, again]) });
    }
  }
}
