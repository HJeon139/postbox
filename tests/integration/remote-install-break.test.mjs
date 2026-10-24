// Breaking a dead owner’s start lock (server/remote/install.mjs’s script and daemon.mjs’s takeLock, #120 L2), with
// real sh and tar: the breaker’s <lock>.break is kept past every age while it works, and a holder whose lock was broken
// and taken leaves the new one. No network; nothing touches the real home folder.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootId, lockOwnerLive, parseLockOwner, sameProcess, startTime } from '../../server/remote/host/proc.mjs';
import { bundle } from '../../server/remote/install.mjs';
import { hostPaths } from '../../shared/remote-protocol.mjs';
import {
  attachCounting,
  attachStarting,
  deadPid,
  installOnce,
  installPaused,
  installShell,
  lockOwner,
  machines,
  SKIP,
  top,
  until,
  V,
  VERSION,
} from './remote-install-fixtures.mjs';

/** The version’s start lock and its break lock, and how to leave each as an owner that died holding it would. @param {any} m */
function deadLocks(m) {
  const root = join(m.home, '.postbox-remote');
  const lock = hostPaths(m.home, VERSION).lock;
  const brk = `${lock}.break`;
  const dead = JSON.stringify({ pid: deadPid(), bootId: bootId(), startTime: 1 });
  const deadLock = () => {
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(join(lock, 'owner'), dead);
  };
  const deadBreak = () => {
    deadLock();
    mkdirSync(brk, { mode: 0o700 });
    writeFileSync(join(brk, 'owner'), dead);
  };
  return { root, lock, brk, dead, deadLock, deadBreak };
}

/**
 * A break lock whose breaker died holding it is broken at once, however new: by an install, and by an attach.
 * @param {any} m @param {Buffer} tar @param {ReturnType<typeof deadLocks>} locks
 * @param {(a: ReturnType<typeof attachCounting> | null) => void} track  the attach under way, for the test’s cleanup
 */
async function deadBreakerBroken(m, tar, { root, deadBreak }, track) {
  deadBreak();
  rmSync(join(root, VERSION), { recursive: true });
  const again = installOnce(m, tar);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, `installed ${VERSION}\n`);
  assert.deepEqual(top(root), [VERSION, 'locks'], 'the dead breaker’s break lock went, and the start lock');
  deadBreak();
  const b = attachCounting(m.home);
  track(b);
  assert.ok(await until(() => b.state.spawned > 0), 'the attach broke both and started the daemon');
  assert.equal(b.state.waitsBefore, 0, 'without waiting for them to age');
  track(null);
  assert.equal(await b.end(), 69);
  assert.deepEqual(readdirSync(join(root, 'locks')), []);
}

test('an install paused while it breaks a dead owner’s start lock keeps <lock>.break past every age: an attach and another install neither break it nor enter, and the attach goes on once it’s free', {
  skip: SKIP,
}, async () => {
  const m = machines();
  /** @type {ReturnType<typeof attachCounting> | null} */
  let attach = null;
  const go = join(m.root, 'go');
  /** @type {Promise<unknown> | null} */
  let install = null;
  /** @type {() => void} */
  let resume = () => {};
  try {
    const { tar } = bundle({ version: VERSION });
    const locks = deadLocks(m);
    const { root, lock, brk, dead } = locks;
    locks.deadLock();
    const { done, pid } = await installPaused(m, tar, go, 'BREAK');
    install = done;
    // Three minutes old, as a suspended install could leave it: past daemon.mjs’s age limits and the script’s minute.
    const old = new Date(Date.now() - 3 * 60_000);
    utimesSync(brk, old, old);
    attach = attachCounting(m.home);
    const a = attach;
    await until(() => a.state.waits >= 20 || a.state.spawned > 0);
    assert.equal(a.state.spawned, 0, 'the attach started no daemon');
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), dead, 'nor broke the start lock under the paused install');
    const r = installOnce(m, tar);
    assert.equal(r.status, 75, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`Postbox ${V} is starting on this host; install again in a moment`));
    const breaker = parseLockOwner(readFileSync(join(brk, 'owner'), 'utf8'));
    assert.ok(installShell(breaker?.pid, pid) && lockOwnerLive(breaker), 'the break lock is still the paused install’s');
    assert.equal(existsSync(join(root, VERSION)), false, 'and nothing was installed');
    // The attach waits on, so the install, once it goes on, takes the lock it frees rather than racing it.
    a.state.hold = new Promise((r) => (resume = () => r(undefined)));
    const waits = a.state.waits;
    await until(() => a.state.waits > waits);
    writeFileSync(go, '');
    const first = await done;
    resume();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, `installed ${VERSION}\n`);
    assert.ok(await until(() => a.state.spawned > 0), 'the attach went on once the install was done');
    assert.equal(lockOwner(lock)?.pid, process.pid);
    attach = null;
    assert.equal(await a.end(), 69);
    assert.deepEqual(readdirSync(join(root, 'locks')), [], 'every lock was dropped');
    await deadBreakerBroken(m, tar, locks, (a) => (attach = a));
  } finally {
    resume();
    await attach?.end();
    writeFileSync(go, '');
    await install;
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('an attach paused while it breaks a dead owner’s start lock keeps <lock>.break past every age: an install neither breaks it nor enters', {
  skip: SKIP,
}, async () => {
  const m = machines();
  /** @type {ReturnType<typeof attachCounting> | null} */
  let attach = null;
  try {
    const { tar } = bundle({ version: VERSION });
    const root = join(m.home, '.postbox-remote');
    const lock = hostPaths(m.home, VERSION).lock;
    const brk = `${lock}.break`;
    const dead = JSON.stringify({ pid: deadPid(), bootId: bootId(), startTime: 1 });
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(join(lock, 'owner'), dead);
    const read = (/** @type {string} */ f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
    /** What an install did and found while the attach was paused. @type {any} */
    let during = null;
    const paused = () => {
      const old = new Date(Date.now() - 3 * 60_000);
      utimesSync(brk, old, old);
      const r = installOnce(m, tar);
      during = { status: r.status, out: `${r.stdout}${r.stderr}`, lock: read(join(lock, 'owner')), brk: read(join(brk, 'owner')) };
    };
    attach = attachCounting(m.home, { proc: { bootId, startTime, sameProcess, paused } });
    const a = attach;
    assert.ok(await until(() => a.state.spawned > 0), 'the paused attach went on and started the daemon');
    assert.ok(during, 'it paused');
    assert.equal(during.status, 75, during.out);
    assert.equal(during.lock, dead, 'the install didn’t break the start lock under the paused attach');
    assert.deepEqual(JSON.parse(during.brk ?? 'null'), { pid: process.pid, bootId: bootId(), startTime: startTime(process.pid) }, 'nor its break lock');
    assert.equal(existsSync(join(root, VERSION, 'manifest.sha256')), false, 'and installed nothing');
    attach = null;
    assert.equal(await a.end(), 69);
    assert.deepEqual(readdirSync(join(root, 'locks')), [], 'every lock was dropped');
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`, 'and the next install goes on');
  } finally {
    await attach?.end();
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a holder whose start lock was broken and taken meanwhile leaves the new one: the install’s exit, and an attach’s', { skip: SKIP }, async () => {
  const m = machines();
  const hold = join(m.root, 'hold');
  /** @type {Promise<unknown> | null} */
  let install = null;
  /** @type {Awaited<ReturnType<typeof attachStarting>> | null} */
  let attach = null;
  try {
    const { tar } = bundle({ version: VERSION });
    const root = join(m.home, '.postbox-remote');
    const lock = hostPaths(m.home, VERSION).lock;
    // Each new lock is one just made, with no record yet: the shape a release by age or name alone would remove.
    const replace = () => {
      rmSync(lock, { recursive: true });
      mkdirSync(lock, { mode: 0o700 });
    };
    const { done } = await installPaused(m, tar, hold, 'HOLD');
    install = done;
    replace();
    writeFileSync(hold, '');
    const r = await done;
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(root, 'locks')), [`${VERSION}.lock`], 'the install left the new lock');
    assert.deepEqual(readdirSync(lock), [], 'as it was');
    rmSync(lock, { recursive: true });
    // An attach holding it while its serve starts, the same.
    attach = await attachStarting(m.home);
    assert.equal(lockOwner(lock)?.pid, process.pid);
    replace();
    const a = attach;
    attach = null;
    assert.equal(await a.end(), 69);
    assert.deepEqual(readdirSync(join(root, 'locks')), [`${VERSION}.lock`], 'the attach left the new lock');
    assert.deepEqual(readdirSync(lock), [], 'as it was');
  } finally {
    await attach?.end();
    writeFileSync(hold, '');
    await install;
    rmSync(m.root, { recursive: true, force: true });
  }
});
