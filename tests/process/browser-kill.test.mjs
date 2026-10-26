// A UAT or screenshot run whose node is SIGKILLed, as an agent harness ends a background job at the end of its turn,
// leaves no Chromium behind. Chrome on a DevTools port, as tools/cdp.mjs ran it, lived on with no parent, and runs
// piled them up; Playwright’s headless shell, as tools/browser.mjs runs it, exits when its pipe closes. The run is
// tests/fixtures/browser-hold.mjs, started both ways tools/browser.mjs launches.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { childrenOf, chromiumMissing, isChromium, running } from './chrome.mjs';

const skip = await chromiumMissing();
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long the run may take to start Chromium and load its page, and Chromium to exit after it, on a busy computer.
const READY_MS = 60_000;
const GONE_MS = 15_000;
/** Every Chromium a test saw, to stop any that a failing test left. @type {number[]} */
const seen = [];

after(() => {
  for (const pid of seen.filter(running)) process.kill(pid, 'SIGKILL');
});

/** Starts the run, and resolves with it once it prints “ready”. @param {string[]} args */
async function hold(args) {
  const child = spawn(process.execPath, [join(ROOT, 'tests', 'fixtures', 'browser-hold.mjs'), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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

for (const how of ['detached', 'not detached']) {
  test(`a SIGKILLed run leaves no Chromium, ${how}`, { skip, timeout: READY_MS + GONE_MS + 10_000 }, async () => {
    const run = await hold(how === 'detached' ? ['detached'] : []);
    assert.ok(run.ready, `the run printed “ready”:\n${run.said()}`);
    const chromium = childrenOf(/** @type {number} */ (run.child.pid)).filter(isChromium);
    seen.push(...chromium);
    assert.equal(chromium.length, 1, 'the run started one Chromium');
    run.child.kill('SIGKILL');
    for (const end = Date.now() + GONE_MS; chromium.some(running) && Date.now() < end; ) await sleep(250);
    assert.deepEqual(chromium.filter(running), [], `Chromium exited within ${GONE_MS / 1000} s of its run`);
  });
}
