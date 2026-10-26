// A UAT or screenshot run whose node is SIGKILLed, as an agent harness ends a background job at the end of its turn,
// leaves no Chromium behind, nor any of its helper processes. Chrome on a DevTools port, as tools/cdp.mjs ran it,
// lived on with no parent, and runs piled them up; Playwright’s headless shell, as tools/browser.mjs runs it, exits
// when its pipe closes. The run is tests/fixtures/browser-hold.mjs, started both ways tools/browser.mjs launches. A
// SIGTERM ends a screenshot run as it would without a browser, and a Chromium that won’t close is killed.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tools/browser.mjs';
import { childrenOf, chromiumMissing, isChromium, running } from './chrome.mjs';

const skip = await chromiumMissing();
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long the run may take to start Chromium and load its page, and Chromium to exit after it, on a busy computer.
const READY_MS = 60_000;
const GONE_MS = 15_000;
/** Every run and Chromium process a test saw, to stop any that a failing test left. @type {number[]} */
const seen = [];

after(() => {
  for (const pid of seen.filter(running)) process.kill(pid, 'SIGKILL');
});

/** A process’s Chromiums and every process under them, as they run now. @param {number} pid */
function chromiumOf(pid) {
  const all = childrenOf(pid).filter(isChromium);
  for (let i = 0; i < all.length; i++) all.push(...childrenOf(all[i]));
  seen.push(...all);
  return all;
}

/** Waits until none of pids runs, or GONE_MS has passed. @param {number[]} pids */
async function gone(pids) {
  for (const end = Date.now() + GONE_MS; pids.some(running) && Date.now() < end; ) await sleep(250);
}

/** Starts the run, and resolves with it once it prints “ready”. @param {string[]} args */
async function hold(args) {
  const child = spawn(process.execPath, [join(ROOT, 'tests', 'fixtures', 'browser-hold.mjs'), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { child, ready, said: () => said };
}

for (const [how, signal] of [
  ['detached', 'SIGKILL'],
  ['not detached', 'SIGKILL'],
  ['not detached', 'SIGTERM'],
]) {
  test(`a run ended with ${signal} leaves no Chromium, ${how}`, { skip, timeout: READY_MS + GONE_MS + 10_000 }, async () => {
    const run = await hold(how === 'detached' ? ['detached'] : []);
    assert.ok(run.ready, `the run printed “ready”:\n${run.said()}`);
    const [browser, ...helpers] = chromiumOf(/** @type {number} */ (run.child.pid));
    assert.ok(browser && isChromium(browser), 'the run started a Chromium');
    assert.ok(helpers.length > 0, 'and it has helper processes, a renderer at least');
    run.child.kill(/** @type {NodeJS.Signals} */ (signal));
    await gone([/** @type {number} */ (run.child.pid), browser, ...helpers]);
    assert.equal(running(/** @type {number} */ (run.child.pid)), false, 'the run ended');
    assert.deepEqual([browser, ...helpers].filter(running), [], `Chromium and its helpers exited within ${GONE_MS / 1000} s of the run`);
  });
}

test('a Chromium that won’t close is killed after the wait close() gives it, with its helpers', { skip, timeout: READY_MS + GONE_MS }, async () => {
  const page = await launch();
  const [browser, ...helpers] = chromiumOf(process.pid);
  assert.ok(browser, 'this process started a Chromium');
  // Stopped, it can’t answer Playwright’s close, as a hung Chromium can’t.
  process.kill(browser, 'SIGSTOP');
  const started = Date.now();
  await page.close(2000);
  assert.ok(Date.now() - started < GONE_MS, `close() resolved after ${Date.now() - started} ms`);
  await gone([browser, ...helpers]);
  assert.deepEqual([browser, ...helpers].filter(running), [], 'Chromium and its helpers are gone');
});
