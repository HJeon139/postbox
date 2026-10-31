// The platforms Postbox’s Redis 8 store runs on (server/redis-platform.mjs; designs/508/design.md, “Storage: a Redis 8
// server that Postbox bundles and runs”, “License and platforms”): macOS on Intel and Windows are refused at start,
// before anything is downloaded or written, with a message that names the platform and the supported ones.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { main } from '../bin/postbox.mjs';
import { checkPlatform } from '../server/redis-platform.mjs';

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pb-redis-platform-'));
});
after(() => rm(tmp, { recursive: true, force: true }));

const SUPPORTED = 'macOS on Apple silicon (arm64), Linux on arm64 and Linux on x64';

test('macOS on Apple silicon, Linux on arm64 and Linux on x64 are supported, each with its build', () => {
  assert.deepEqual(checkPlatform({ platform: 'darwin', arch: 'arm64' }), { ok: true, target: 'darwin-arm64' });
  assert.deepEqual(checkPlatform({ platform: 'linux', arch: 'arm64' }), { ok: true, target: 'linux-arm64' });
  assert.deepEqual(checkPlatform({ platform: 'linux', arch: 'x64' }), { ok: true, target: 'linux-x64' });
});

test('macOS on Intel is refused with a message that names it and the supported platforms', () => {
  const r = checkPlatform({ platform: 'darwin', arch: 'x64' });
  assert.equal(r.ok, false);
  assert.match(r.message, /^Postbox doesn’t run on macOS on Intel \(darwin x64\)\./);
  assert.ok(r.message.includes(SUPPORTED), r.message);
});

test('Windows is refused with a message that names it, the supported platforms, and WSL as a way to run it', () => {
  for (const arch of ['x64', 'arm64']) {
    const r = checkPlatform({ platform: 'win32', arch });
    assert.equal(r.ok, false);
    assert.match(r.message, new RegExp(`^Postbox doesn’t run on Windows \\(win32 ${arch}\\)\\.`));
    assert.ok(r.message.includes(SUPPORTED), r.message);
    assert.match(r.message, /WSL/);
  }
});

test('any other platform or architecture is refused too, named as Node names it', () => {
  for (const [platform, arch] of [
    ['linux', 'ia32'],
    ['linux', 's390x'],
    ['freebsd', 'x64'],
  ]) {
    const r = checkPlatform({ platform, arch });
    assert.equal(r.ok, false, `${platform} ${arch}`);
    assert.ok(r.message.includes(`(${platform} ${arch})`), r.message);
    assert.ok(r.message.includes(SUPPORTED), r.message);
  }
});

/**
 * Runs the postbox command on a given platform, with process.exit and console.error caught.
 * @param {string[]} argv
 * @param {{ platform: string, arch: string }} host
 */
async function runOn(argv, host) {
  const errors = [];
  const started = [];
  const { exit } = process;
  const { error } = console;
  process.exit = /** @type {any} */ (
    (code) => {
      throw Object.assign(new Error('exit'), { exitCode: code });
    }
  );
  console.error = (...a) => errors.push(a.join(' '));
  try {
    await main(argv, /** @type {any} */ (async (o) => started.push(o)), host);
    return { exitCode: null, errors, started };
  } catch (e) {
    if (e.exitCode === undefined) throw e;
    return { exitCode: e.exitCode, errors, started };
  } finally {
    process.exit = exit;
    console.error = error;
  }
}

test('postbox refuses to start on macOS on Intel before it touches the data folder, and exits 1 with the message', async () => {
  const data = join(tmp, 'intel');
  const r = await runOn(['--port', '45123', '--data', data], { platform: 'darwin', arch: 'x64' });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.started, []);
  assert.equal(existsSync(data), false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0], checkPlatform({ platform: 'darwin', arch: 'x64' }).message);
});

test('postbox refuses to start on Windows the same way', async () => {
  const data = join(tmp, 'windows');
  const r = await runOn(['--port', '45124', '--data', data], { platform: 'win32', arch: 'x64' });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.started, []);
  assert.equal(existsSync(data), false);
  assert.match(r.errors[0], /Windows/);
});
