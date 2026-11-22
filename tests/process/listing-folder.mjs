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
 * Each process with a file open under dir, as “pid command”, from lsof’s field output (p and c lines). An lsof that
 * isn’t there, is stopped, exits past 1, or prints only an error is no answer, never “none”, which it would prove
 * nothing about.
 * @param {string} dir @param {{ lsof?: string }} [o]  the lsof to run, which a test replaces
 * @returns {{ ok: true, found: string[] } | { ok: false, why: string }}
 */
export function holders(dir, { lsof = 'lsof' } = {}) {
  const r = spawnSync(lsof, ['-n', '-F', 'pc', '+D', dir], { encoding: 'utf8', timeout: 20_000 });
  if (r.error) return { ok: false, why: `lsof couldn’t run (${r.error.message})` };
  if (r.signal) return { ok: false, why: `lsof was stopped by ${r.signal}` };
  const out = r.stdout ?? '';
  // macOS’s lsof exits 1 even when it lists holders, so 1 is an answer unless it printed nothing but an error.
  const said = (r.stderr ?? '').trim().split('\n')[0];
  if (r.status !== 0 && r.status !== 1) return { ok: false, why: `lsof exited ${r.status}${said ? `: ${said}` : ''}` };
  if (!out.trim() && said) return { ok: false, why: `lsof found nothing and said: ${said}` };
  /** @type {string[]} */
  const found = [];
  let pid = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('c') && pid && Number(pid) !== process.pid) found.push(`${pid} ${line.slice(1)}`);
  }
  return { ok: true, found };
}

/**
 * What’s in the folder: its files with their times, and the processes holding any of them, or why that’s unknown.
 * @param {string} dir @param {number | undefined} closedAt @param {{ lsof?: string }} [o]
 */
export function writers(dir, closedAt, o = {}) {
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
  const held = holders(dir, o);
  const procs = held.ok ? held.found.join(' | ') || 'none' : `unknown: ${held.why}`;
  return `files: ${left(dir).join(', ') || 'none'}; processes: ${procs}`;
}

/** writers, or why it couldn’t say, so a diagnostic that fails never stops the removal. @param {() => string} describe */
function safely(describe) {
  try {
    return describe();
  } catch (e) {
    return `(couldn’t say what was there: ${/** @type {Error} */ (e).message})`;
  }
}

/**
 * Removes the listing’s folder, retrying when the first try fails, and records what was there then as a diagnostic.
 * @param {import('node:test').TestContext} t @param {string} dir @param {number | undefined} closedAt
 * @param {() => string} [describe]  what was there, writers by default, which a test replaces
 */
export function removeListing(t, dir, closedAt, describe = () => writers(dir, closedAt)) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    t.diagnostic(`#1562: the listing’s folder was still being written after the CLI closed, so its removal retried. ${safely(describe)}`);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch (again) {
      throw new Error(`Couldn’t remove the listing’s folder: ${safely(describe)}`, { cause: new AggregateError([e, again]) });
    }
  }
}
