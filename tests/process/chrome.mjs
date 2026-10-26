// What the process tests that drive Chromium through tools/browser.mjs share: whether Playwright’s Chromium is here to
// run, a free port, and the processes a process started.

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * The reason to skip, when a launch failed because Playwright’s Chromium isn’t installed, or null when it failed
 * for any other reason: a new Chromium revision that won’t start, or a system library missing on the runner, is a
 * failure, never a skip.
 * @param {unknown} error
 */
export function notInstalled(error) {
  const first = String(error instanceof Error ? error.message : error).split('\n')[0];
  return /Executable doesn't exist at|\bENOENT\b/.test(first)
    ? `Playwright’s Chromium isn’t installed (npx playwright install chromium downloads it): ${first}`
    : null;
}

/**
 * Why the tests that drive Chromium should skip, or false when they can run: give it to node:test’s `skip`. It
 * starts Playwright’s Chromium once to see, as tools/browser.mjs starts it, and throws when it’s installed but
 * won’t start, so the test file fails.
 * @returns {Promise<string | false>}
 */
export async function chromiumMissing() {
  const { chromium } = await import('@playwright/test');
  try {
    await (await chromium.launch()).close();
    return false;
  } catch (e) {
    const why = notInstalled(e);
    if (why) return why;
    throw new Error(`Playwright’s Chromium is installed but didn’t start: ${String(/** @type {Error} */ (e).message).split('\n')[0]}`, { cause: e });
  }
}

/** The processes that pid started and that are still running, by their pids. @param {number} pid */
export const childrenOf = (pid) =>
  spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .map(Number);

/** Whether a process is still running. @param {number} pid */
export function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether a process is a Chromium, by its command line. @param {number} pid */
export const isChromium = (pid) => /chrom/i.test(spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout);

/** Whether nothing listens on a port of 127.0.0.1. @param {number} port @returns {Promise<boolean>} */
export const free = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });

/**
 * A free port other than those taken, picked at random below the ephemeral ranges, as tests/browser/postbox.mjs
 * picks them: the system hands those out in order, so one picked there could be given away before it’s bound.
 * @param {number[]} [taken]
 */
export async function freePort(taken = []) {
  for (let i = 0; i < 100; i++) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    if (!taken.includes(port) && (await free(port))) return port;
  }
  throw new Error('No free port between 20000 and 32000 after 100 tries.');
}
