// A Postbox killed while view_app’s browser runs (#95) leaves no Chromium behind, nor any of its helpers: AppBrowser
// starts Chromium’s headless shell over a pipe, and it exits when the pipe closes, as tools/browser.mjs’s does
// (tests/process/browser-kill.test.mjs). The run is tests/fixtures/view-app-hold.mjs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AppBrowser } from '../../server/view-app/browser.mjs';
import { playwrightBrowsers } from '../fixtures/playwright-browsers.mjs';
import { childrenOf, isChromium, running } from './chrome.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY_MS = 60_000;
const GONE_MS = 15_000;
const skip = new AppBrowser({ dir: playwrightBrowsers() }).status() !== 'ready' ? 'Playwright’s headless shell isn’t installed' : false;
/** @type {number[]} */
const seen = [];

after(() => {
  for (const pid of seen.filter(running)) process.kill(pid, 'SIGKILL');
});

/** A process’s Chromiums and every process under them. @param {number} pid */
function chromiumOf(pid) {
  const all = childrenOf(pid).filter(isChromium);
  for (let i = 0; i < all.length; i++) all.push(...childrenOf(all[i]));
  seen.push(...all);
  return all;
}

test('a Postbox SIGKILLed while view_app’s browser runs leaves no Chromium', { skip, timeout: READY_MS + GONE_MS + 10_000 }, async () => {
  const child = spawn(process.execPath, [join(ROOT, 'tests', 'fixtures', 'view-app-hold.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  seen.push(/** @type {number} */ (child.pid));
  let said = '';
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const ready = await new Promise((ok) => {
    timer = setTimeout(ok, READY_MS, false);
    const read = (d) => {
      said += d;
      if (said.includes('ready')) ok(true);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', () => ok(false));
  });
  clearTimeout(timer);
  assert.ok(ready, `the run printed “ready”:\n${said}`);
  const [browser, ...helpers] = chromiumOf(/** @type {number} */ (child.pid));
  assert.ok(browser && isChromium(browser), 'the run started a Chromium');
  child.kill('SIGKILL');
  for (const end = Date.now() + GONE_MS; [browser, ...helpers].some(running) && Date.now() < end; ) await sleep(250);
  assert.deepEqual([browser, ...helpers].filter(running), [], `Chromium and its helpers exited within ${GONE_MS / 1000} s`);
});
