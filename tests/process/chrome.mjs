// What the process tests that drive Chrome through tools/cdp.mjs share: a Chrome to run, found wherever this computer
// or CI keeps one, and a free port. tools/cdp.mjs reads CHROME as it loads, and falls back to macOS’s path, so a test
// calls useChrome() first and imports cdp.mjs (or what imports it) after, and the processes it starts inherit CHROME.

import { accessSync, constants, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';

// What `command -v` would find, in this order: Google Chrome on Linux (CI’s runners have it), then Chromium.
const NAMES = ['google-chrome', 'chromium', 'chromium-browser', 'chrome'];
const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Whether path is a file this user can run. @param {string} path */
function runnable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Playwright’s own Chromium, when it has been downloaded (npx playwright install chromium), else null. */
async function playwrights() {
  try {
    const { chromium } = await import('@playwright/test');
    const path = chromium.executablePath();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** Chrome’s path: CHROME, else the first of NAMES on PATH, else macOS’s Chrome, else Playwright’s Chromium. */
async function findChrome() {
  if (process.env.CHROME) return runnable(process.env.CHROME) ? { path: process.env.CHROME } : { why: `CHROME is ${process.env.CHROME}, which can’t be run.` };
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const name of NAMES) if (runnable(join(dir, name))) return { path: join(dir, name) };
  if (process.platform === 'darwin' && runnable(MAC)) return { path: MAC };
  const bundled = await playwrights();
  if (bundled) return { path: bundled };
  return {
    why: 'No Chrome found: set CHROME to its path, put google-chrome, chromium or chrome on PATH, or run npx playwright install chromium.',
  };
}

/**
 * Finds Chrome and sets CHROME to it, for tools/cdp.mjs and for every process the test starts. Returns why the
 * tests that need it should skip, or false when they can run: give it to node:test’s `skip`.
 * @returns {Promise<string | false>}
 */
export async function useChrome() {
  const found = await findChrome();
  if (!found.path) return found.why ?? 'No Chrome found.';
  process.env.CHROME = found.path;
  return false;
}

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
