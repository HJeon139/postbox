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

/** The summary after “failing tests:”, or, with none, each failure line as it streamed. @param {string} out */
function listed(out) {
  const at = out.search(/^[ℹ✖] failing tests:$/m);
  if (at >= 0) return out.slice(at).split('\n').slice(0, 80);
  return out
    .split('\n')
    .filter((l) => /^\s*(✖|not ok)/.test(l))
    .slice(0, 40);
}

/**
 * What the child run said failed, with each failure’s own error: node --test lists them after “failing tests:”. Only
 * the names left a nested remote test’s flake impossible to tell apart from this test’s (#464-b2a, #843). A child
 * killed at its timeout prints no summary, so then its failure lines as they streamed; and the end of its stderr,
 * where a crash outside any test shows.
 * @param {{ stdout?: string | null, stderr?: string | null }} r
 */
function failures(r) {
  const lines = listed(r.stdout ?? '');
  const err = (r.stderr ?? '').trim();
  return [lines.length ? lines.join('\n') : '(none listed)', ...(err ? [`stderr:\n${err.split('\n').slice(-20).join('\n')}`] : [])].join('\n');
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
  // The spec reporter, named: node 22, which CI runs, writes TAP to a pipe, with no “failing tests:” summary.
  const args = ['--test', '--test-reporter=spec', '--test-timeout=60000', '--import', './tests/guard.mjs', ...files.map((name) => join('tests', name))];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, timeout: 240_000, encoding: 'utf8', maxBuffer: 1 << 28 });
  const ran = Number(/^(?:ℹ|#) tests (\d+)$/m.exec(r.stdout ?? '')?.[1] ?? 0);
  // A child killed at its timeout prints no count, so this fails first: it says what failed too.
  assert.ok(ran > 100, `ran ${ran} tests (exit ${r.status ?? r.signal}), failing:\n${failures(r)}`);
  assert.equal(r.status, 0, `exit ${r.status ?? r.signal}, failing:\n${failures(r)}`);
  const left = fs.readdirSync(dir).filter((name) => !OUT_OF_SCOPE.test(name));
  assert.deepEqual(left, [], 'what the socket tests left in TMPDIR');
});

test('a child with no summary, as one killed at its timeout, still names its failures, and shows its stderr', () => {
  // As node 22’s TAP reporter streamed it before a kill: the failure lines, and no “failing tests:” section.
  const tap = 'ok 1 - #464 one\nnot ok 2 - #464-b2a a 127 doesn’t connect it again\n# Subtest: next\n';
  assert.match(failures({ stdout: tap, stderr: '' }), /not ok 2 - #464-b2a/);
  assert.match(failures({ stdout: '', stderr: 'node:internal x\nUnhandled rejection: boom' }), /\(none listed\)\nstderr:\n.*Unhandled rejection: boom/s);
});
