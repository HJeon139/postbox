// What a passing `test` or `test:integration` stage leaves in the gate’s run folder fails npm run check (#922). The
// stages here plant entries in a real temp folder; nothing spawns.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { check } from '../tools/check.mjs';
import { tempDir } from './temp-dirs.mjs';

/**
 * A run folder in a real temp folder, which records how often it was closed, and a run whose stages make the
 * planted entries in their TMPDIR and exit with code.
 */
function planting(/** @type {Record<string, string[]>} */ plant, code = 0) {
  const path = tempDir('pb-check-');
  const r = { closed: 0 };
  const runDir = { open: () => ({ path, close: () => void r.closed++, list: () => fs.readdirSync(path) }) };
  const run = async (/** @type {string} */ s, /** @type {Record<string, string> | undefined} */ env) => {
    for (const name of plant[s] ?? []) fs.mkdirSync(join(env?.TMPDIR ?? path, name));
    return code;
  };
  return { path, r, runDir, run };
}

for (const stage of ['test', 'test:integration']) {
  test(`what ${stage} leaves in the run’s folder fails the check, named after the summary, and the folder is still removed`, async () => {
    const p = planting({ [stage]: ['pb-leak-AbC123'] });
    /** @type {string[]} */
    const log = [];
    const code = await check({ stages: ['test', 'test:integration'], run: p.run, runDir: p.runDir, now: () => 0, log: (m) => log.push(m) });
    assert.equal(code, 1);
    assert.match(log.at(-2) ?? '', new RegExp(`^npm run check failed at ${stage} `), 'the summary comes first');
    assert.equal(log.at(-1), `✖ ${stage} left 1 entry in its temp folder ${p.path}: pb-leak-…`, 'and the reason right after it');
    assert.equal(p.r.closed, 1);
  });
}

test('Playwright’s and Node’s own entries, and what test:process leaves, don’t fail the check', async () => {
  const own = ['playwright-x', 'playwright_chromiumdev_profile-AbC123', 'node-compile-cache', 'mcs-telemetry-1'];
  const p = planting({ test: own, 'test:process': ['pb-x-AbC123'] });
  const code = await check({ stages: ['test', 'test:integration', 'test:process'], run: p.run, runDir: p.runDir, now: () => 0, log: () => {} });
  assert.equal(code, 0);
});

test('a failing stage keeps its own exit code, whatever it leaves', async () => {
  const p = planting({ test: ['pb-leak-AbC123'] }, 3);
  assert.equal(await check({ stages: ['test'], run: p.run, runDir: p.runDir, now: () => 0, log: () => {} }), 3);
  assert.equal(p.r.closed, 1);
});

test('only what a stage adds counts against it, not what an earlier stage left', async () => {
  const p = planting({ 'test:process': ['pb-x-AbC123'] });
  assert.equal(await check({ stages: ['test:process', 'test'], run: p.run, runDir: p.runDir, now: () => 0, log: () => {} }), 0);
});

for (const name of ['node-compile-cache2', 'xplaywright-1', 'playwrightx', 'my-mcs-telemetry-1']) {
  test(`${name} is a leftover, though it looks like Playwright’s or Node’s own`, async () => {
    const p = planting({ test: [name] });
    assert.equal(await check({ stages: ['test'], run: p.run, runDir: p.runDir, now: () => 0, log: () => {} }), 1);
  });
}

test('a stage a signal stopped exits with the signal’s code, not the leftovers’', async () => {
  const proc = new EventEmitter();
  const p = planting({ test: ['pb-leak-AbC123'] });
  const run = async (/** @type {string} */ s, /** @type {Record<string, string> | undefined} */ env, /** @type {(c: { pid: number }) => void} */ spawned) => {
    spawned({ pid: 4242 });
    proc.emit('SIGINT');
    return p.run(s, env);
  };
  assert.equal(await check({ stages: ['test'], run, runDir: p.runDir, signals: proc, kill: () => {}, now: () => 0, log: () => {} }), 130);
  assert.equal(p.r.closed, 1);
});

test('a run folder that can’t be listed fails the check with a message, and is still removed once', async () => {
  const p = planting({});
  const run = async () => {
    fs.rmSync(p.path, { recursive: true });
    return 0;
  };
  /** @type {string[]} */
  const log = [];
  const code = await check({ stages: ['test'], run, runDir: p.runDir, now: () => 0, log: (m) => log.push(m) });
  assert.equal(code, 1);
  assert.match(log.at(-1) ?? '', new RegExp(`^✖ test: npm run check couldn’t list its temp folder ${p.path}: ENOENT`));
  assert.equal(p.r.closed, 1);
});

test('a run folder that can’t be listed before a clean stage fails the check without running it', async () => {
  const r = { closed: 0 };
  const list = () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  };
  const runDir = { open: () => ({ path: '/tmp/pb-gate-1-AbC123', close: () => void r.closed++, list }) };
  /** @type {string[]} */
  const ran = [];
  /** @type {string[]} */
  const log = [];
  const run = async (/** @type {string} */ s) => {
    ran.push(s);
    return 0;
  };
  const code = await check({ stages: ['lint', 'test', 'test:process'], run, runDir, now: () => 0, log: (m) => log.push(m) });
  assert.equal(code, 1);
  assert.deepEqual(ran, ['lint'], 'neither test nor what comes after it ran');
  assert.equal(log.at(-1), '✖ test: npm run check couldn’t list its temp folder /tmp/pb-gate-1-AbC123: EACCES: permission denied');
  assert.equal(r.closed, 1);
});
