// A key-to-frame bench stopped with Ctrl-C or SIGTERM (#508, tools/bench-key-frame.mjs) removes the data folder of the
// size it was measuring, and stops that size’s Postbox and its Chromium, then exits 130 or 143. Before, Ctrl-C left the
// folder behind, and SIGTERM ended the bench with no cleanup at all. The bench runs with a temp folder of its own as
// TMPDIR, so the test sees every folder it makes.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../temp-dirs.mjs';
import { childrenOf, chromiumMissing, running } from './chrome.mjs';

const skip = await chromiumMissing();
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const START_MS = 60_000;
const EXIT_MS = 20_000;
/** Every process a test saw, to stop any a failing test left. @type {number[]} */
const seen = [];
after(() => {
  for (const pid of seen.filter(running)) process.kill(pid, 'SIGKILL');
});

/** A process and every process under it, as they run now. @param {number} pid */
function treeOf(pid) {
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...childrenOf(all[i]));
  seen.push(...all);
  return all;
}

/** The bench’s size folders in its TMPDIR. @param {string} tmp */
const sizeFolders = (tmp) => readdirSync(tmp).filter((n) => n.startsWith('pb-key-frame-'));

/** Waits until check() holds, or ms pass. @param {() => boolean} check  @param {number} ms */
async function until(check, ms) {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(100);
  return check();
}

/** Starts a bench that measures one small room for longer than the test waits. */
function bench() {
  const tmp = tempDir('pb-bench-signal-');
  const args = ['tools/bench-key-frame.mjs', '--sizes', '200', '--keys', '2000', '--warmup', '1', '--runs', '1', '--out', join(tmp, 'report.md')];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  seen.push(/** @type {number} */ (child.pid));
  let said = '';
  child.stdout.on('data', (d) => (said += d));
  child.stderr.on('data', (d) => (said += d));
  const exited = new Promise((ok) => child.once('exit', (code, signal) => ok({ code, signal })));
  return { child, tmp, exited, said: () => said };
}

for (const [signal, code, when] of /** @type {const} */ ([
  ['SIGINT', 130, 'while it types'],
  ['SIGTERM', 143, 'as its Postbox starts'],
])) {
  test(`${signal} ${when} removes the size’s data folder, stops its Postbox and Chromium, and exits ${code}`, {
    skip,
    timeout: START_MS + EXIT_MS + 10_000,
  }, async () => {
    const run = bench();
    assert.ok(await until(() => sizeFolders(run.tmp).length > 0, START_MS), `the bench made its size’s folder:\n${run.said()}`);
    // While it types: its Postbox has started, seeded the room and answered the page, and Chromium is typing.
    if (signal === 'SIGINT') await sleep(8_000);
    const tree = treeOf(/** @type {number} */ (run.child.pid));
    run.child.kill(signal);
    const timer = setTimeout(() => run.child.kill('SIGKILL'), EXIT_MS);
    const end = await run.exited;
    clearTimeout(timer);
    assert.deepEqual(end, { code, signal: null }, run.said());
    assert.deepEqual(sizeFolders(run.tmp), [], 'the size’s data folder is gone');
    assert.ok(await until(() => !tree.some(running), 5_000), `its Postbox and Chromium exited: ${tree.filter(running).join(', ')}`);
  });
}
