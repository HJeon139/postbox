// What the install’s integration tests share (tests/integration/remote-install*.test.mjs): the version, the launcher
// and fake nodes, a laptop and a host in temp folders, the install run as sshd would run it, attaches that start or
// count their waits, and the start lock’s records.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { main } from '../../server/remote/host/daemon.mjs';
import { hostVersion } from '../../server/remote/host/paths.mjs';
import { bootId, listProcesses, startTime } from '../../server/remote/host/proc.mjs';
import { installCommand } from '../../server/remote/install.mjs';
import { defaultHostSettings } from '../../shared/remote-settings.mjs';

// This checkout’s version, which the daemon’s main() takes from package.json (paths.mjs), so the tests follow each release.
export const VERSION = hostVersion();
/** VERSION as a regular expression matches it. */
export const V = VERSION.replaceAll('.', '\\.');
export const NODE_DIR = dirname(process.execPath);
export const HOST = { id: 'ho_test0001', name: 'host.example.com', settings: defaultHostSettings() };
export const SKIP = process.platform === 'win32' && 'needs a POSIX sh and tar';

/** A temp folder under /tmp, short enough for the daemon’s socket path. */
export const temp = (prefix) => mkdtempSync(`/tmp/${prefix}`);

/** A spawn that runs ssh’s remote command with /bin/sh -c, as sshd hands it to the login shell, with this environment. */
export const localShell = (env) => (_program, args, options) => spawn('/bin/sh', ['-c', args.at(-1)], { ...options, env });

/** A fresh host home and laptop data folder. */
export function machines() {
  const root = temp('pbi-');
  const home = join(root, 'h');
  mkdirSync(home);
  const data = join(root, 'data');
  return { root, home, data, env: { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin:/sbin` } };
}

/** Every file and folder under a folder, with its mode. */
export const modes = (dir) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .sort()
      .map((f) => [f, statSync(join(dir, f)).mode & 0o777]),
  );

/** Runs the install script on `tar`, as sshd would. */
export const installOnce = (m, tar) => spawnSync('/bin/sh', ['-c', installCommand(VERSION)], { input: tar, env: m.env, encoding: 'utf8' });

/** A PID that’s no process’s any more: a child’s, once it has exited. */
export const deadPid = () => spawnSync('/bin/sh', ['-c', 'exit 0']).pid;

/** A record naming this test’s own process, as daemon.mjs’s takeDaemonLock and runner.mjs write theirs. */
export const liveRecord = (extra = {}) => `${JSON.stringify({ ...extra, pid: process.pid, bootId: bootId(), startTime: startTime(process.pid) })}\n`;

/** What’s in ~/.postbox-remote, sorted, once no install’s start lock is left in its locks folder. */
export function top(root) {
  if (existsSync(join(root, 'locks'))) assert.deepEqual(readdirSync(join(root, 'locks')), [], 'no install left its lock');
  return readdirSync(root).sort();
}

/**
 * Starts the install script on `tar` in the background, with one of its test-only pauses: WAIT (POSTBOX_INSTALL_TEST_WAIT),
 * past its first check and before it takes the start lock; HOLD (POSTBOX_INSTALL_TEST_HOLD), just after it has taken
 * it; or BREAK (POSTBOX_INSTALL_TEST_BREAK), holding `<lock>.break` with a stale start lock found, before it removes
 * it. It waits there until `go` exists, having made `<go>.paused`, `<go>.held` or `<go>.breaking` to say it’s there.
 * @param {ReturnType<typeof machines>} m @param {Buffer} tar @param {string} go @param {'WAIT' | 'HOLD' | 'BREAK'} [at]
 */
export async function installPaused(m, tar, go, at = 'WAIT') {
  const child = spawn('/bin/sh', ['-c', installCommand(VERSION)], { env: { ...m.env, [`POSTBOX_INSTALL_TEST_${at}`]: go }, stdio: ['pipe', 'pipe', 'pipe'] });
  const mark = `${go}.${{ WAIT: 'paused', HOLD: 'held', BREAK: 'breaking' }[at]}`;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
  child.stdin.end(tar);
  /** @type {Promise<{ status: number | null, stdout: string, stderr: string }>} */
  const done = new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
  for (let i = 0; i < 500 && !existsSync(mark); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(mark), `the install paused (${stderr})`);
  return { done, pid: child.pid };
}

/**
 * A real attach, daemon.mjs’s own, in this process: nothing answers on the socket, so it takes the attach lock and
 * starts `host serve` (a fake child here), then waits for it with the lock held, until `end` makes the serve exit.
 */
export async function attachStarting(home) {
  /** @type {() => void} */
  let holding = () => {};
  const held = new Promise((r) => (holding = () => r(undefined)));
  /** @type {() => void} */
  let go = () => {};
  const gate = new Promise((r) => (go = () => r(undefined)));
  const serve = Object.assign(new EventEmitter(), { unref() {} });
  const running = main({
    argv: ['attach'],
    home,
    stdin: new PassThrough(),
    stdout: new PassThrough().resume(),
    stderr: { write: () => true },
    spawn: /** @type {any} */ (() => serve),
    // Its first wait is for the serve it started, with the lock held.
    sleep: () => {
      holding();
      return gate;
    },
  });
  await held;
  return {
    async end() {
      serve.emit('exit', 1, null);
      go();
      return running;
    },
  };
}

/** Waits up to five seconds for `f()` to be true, and returns it. @param {() => boolean} f */
export async function until(f) {
  for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  return f();
}

/**
 * A real attach, daemon.mjs’s own, in this process, counting its waits: it waits while the start lock is held, then
 * takes it and starts `host serve` (a fake child, counted in `spawned`, with the waits before it in `waitsBefore`),
 * holding the lock until `end` makes it exit. While `hold` is set, its waits last until that settles too.
 */
export function attachCounting(home, /** @type {Partial<import('../../server/remote/host/daemon.mjs').MainOpts>} */ opts = {}) {
  const state = { waits: 0, spawned: 0, waitsBefore: 0, hold: /** @type {Promise<void> | null} */ (null) };
  const serve = Object.assign(new EventEmitter(), { unref() {} });
  const running = main({
    ...opts,
    argv: ['attach'],
    home,
    stdin: new PassThrough(),
    stdout: new PassThrough().resume(),
    stderr: { write: () => true },
    spawn: /** @type {any} */ (
      () => {
        state.spawned++;
        state.waitsBefore = state.waits;
        return serve;
      }
    ),
    sleep: async (ms) => {
      state.waits++;
      await state.hold;
      await new Promise((r) => setTimeout(r, ms));
    },
  });
  return {
    state,
    end() {
      serve.emit('exit', 1, null);
      return running;
    },
  };
}

/**
 * Whether `owner` is the shell running the install script that `sh -c` (PID `pid`) started: that shell itself where
 * it execs its last command (bash), or its child where it doesn’t (dash, Linux’s /bin/sh).
 * @param {number | undefined} owner @param {number | undefined} pid
 */
export const installShell = (owner, pid) => owner !== undefined && (owner === pid || listProcesses()?.find((p) => p.pid === owner)?.ppid === pid);

/** The start lock’s owner record, parsed, or null if it has none. @param {string} lock */
export const lockOwner = (lock) => (existsSync(join(lock, 'owner')) ? JSON.parse(readFileSync(join(lock, 'owner'), 'utf8')) : null);
