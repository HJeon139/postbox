// The unit tests that bind Unix sockets still pass when TMPDIR is as deep as the gate makes it on macOS (#802): there,
// npm run check sets TMPDIR to its run folder, pb-gate-<pid>-XXXXXX, under macOS’s own temp folder, and a host home
// made under it pushes a turn’s socket path past the daemon’s 108 bytes. The fixtures make their homes under /tmp
// then, and remove them when each test file ends, so nothing is left in TMPDIR either.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PREFIX } from '../../tools/gate-tmp.mjs';
import { tempDir } from '../temp-dirs.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** macOS’s own temp folder, getconf DARWIN_USER_TEMP_DIR, is 48 bytes with its trailing slash. */
const MACOS_TMPDIR_BYTES = 48;
/** The gate’s run folder name with the longest pid Linux gives (pid_max is at most 4,194,304): pb-gate-4194304-XXXXXX. */
const RUN_DIR_NAME_BYTES = `${PREFIX}4194304-XXXXXX`.length;
const OUT_OF_SCOPE = /^(node-compile-cache$|mcs-telemetry-)/;

/** A folder as deep as the gate’s run folder under macOS’s temp folder, with nothing in it. */
function deepTmpdir() {
  const outer = tempDir('pb-deep-', '/tmp');
  const pad = 'd'.repeat(MACOS_TMPDIR_BYTES - outer.length - 2);
  const dir = join(outer, pad, 'r'.repeat(RUN_DIR_NAME_BYTES));
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(dir.length, MACOS_TMPDIR_BYTES + RUN_DIR_NAME_BYTES);
  return dir;
}

test('the socket tests pass, and leave nothing, with TMPDIR as deep as the gate’s run folder on macOS', {
  skip: process.platform === 'win32' && 'needs /tmp',
  timeout: 300_000,
}, () => {
  const dir = deepTmpdir();
  const env = { ...process.env, TMPDIR: dir };
  // Without this, the child node --test reports to this one’s runner instead of running as a run of its own.
  delete env.NODE_TEST_CONTEXT;
  const files = fs.readdirSync(join(ROOT, 'tests')).filter((name) => /^remote-.*\.test\.mjs$/.test(name));
  const args = ['--test', '--test-timeout=60000', '--import', './tests/guard.mjs', ...files.map((name) => join('tests', name))];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, timeout: 240_000, encoding: 'utf8', maxBuffer: 1 << 28 });
  const ran = Number(/^(?:ℹ|#) tests (\d+)$/m.exec(r.stdout ?? '')?.[1] ?? 0);
  const failed = (r.stdout ?? '').split('\n').filter((line) => /^(?:✖|not ok)/.test(line));
  assert.ok(ran > 100, `ran ${ran} tests (exit ${r.status ?? r.signal})`);
  assert.equal(r.status, 0, `exit ${r.status ?? r.signal}, failing:\n${failed.slice(0, 20).join('\n')}`);
  const left = fs.readdirSync(dir).filter((name) => !OUT_OF_SCOPE.test(name));
  assert.deepEqual(left, [], 'what the socket tests left in TMPDIR');
});
