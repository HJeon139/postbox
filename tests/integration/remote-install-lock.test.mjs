// The version’s start lock between an install and an attach (server/remote/install.mjs’s script and daemon.mjs’s
// takeLock, #120 L2), with real sh and tar: a stale lock, an attach that takes it mid-install, a holder past both stale
// times, and an owner that’s dead. No network; nothing touches the real home folder.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootId, lockOwnerLive, parseLockOwner, startTime } from '../../server/remote/host/proc.mjs';
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
  modes,
  SKIP,
  top,
  until,
  V,
  VERSION,
} from './remote-install-fixtures.mjs';

test('a start lock more than a minute old, from an attach that died holding it, doesn’t block an install', { skip: SKIP }, () => {
  const m = machines();
  try {
    const { tar, files } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const changed = join(root, VERSION, 'server', 'remote', 'host', 'host.mjs');
    writeFileSync(changed, 'console.log("old code");\n');
    const lock = hostPaths(m.home, VERSION).lock;
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    // Three minutes: past find -mmin +1 everywhere (BusyBox’s counts whole minutes, so it needs two).
    const old = new Date(Date.now() - 3 * 60_000);
    utimesSync(lock, old, old);
    const r = installOnce(m, tar);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `installed ${VERSION}\n`);
    assert.deepEqual(readFileSync(changed), files.find((f) => f.path === 'server/remote/host/host.mjs')?.data);
    assert.deepEqual(top(root), [VERSION, 'locks'], 'the stale lock went, and the install dropped its own');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('an attach that takes the lock while an install is past its first check makes the install refuse, and the code stays', { skip: SKIP }, async () => {
  const m = machines();
  /** @type {Awaited<ReturnType<typeof attachStarting>> | null} */
  let attach = null;
  try {
    const { tar, files } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    const changed = join(code, 'server', 'remote', 'host', 'host.mjs');
    writeFileSync(changed, 'console.log("old code");\n');
    const manifest = join(code, 'manifest.sha256');
    writeFileSync(manifest, `${createHash('sha256').update('console.log("old code");\n').digest('hex')}  server/remote/host/host.mjs\n`);
    const before = modes(code);
    const go = join(m.root, 'go');
    const { done } = await installPaused(m, tar, go);
    // While it waits, an attach finds no daemon and starts one, holding the lock.
    attach = await attachStarting(m.home);
    writeFileSync(go, '');
    const r = await done;
    assert.equal(r.status, 75, `${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`Postbox ${V} is starting on this host; install again in a moment`));
    assert.equal(readFileSync(changed, 'utf8'), 'console.log("old code");\n', 'the starting version’s code is untouched');
    assert.deepEqual(modes(code), { ...before, 'daemon.log': 0o600 }, 'nothing went or came but the attach’s log');
    assert.deepEqual(readdirSync(root).sort(), [VERSION, 'locks'], 'no temporary or old folder is left');
    // Once the attach gives up and drops the lock, the install replaces the code.
    const a = attach;
    attach = null;
    assert.equal(await a.end(), 69);
    const lock = hostPaths(m.home, VERSION).lock;
    for (let i = 0; i < 100 && existsSync(lock); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(!existsSync(lock), 'the attach dropped its lock');
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    assert.deepEqual(readFileSync(changed), files.find((f) => f.path === 'server/remote/host/host.mjs')?.data);
  } finally {
    await attach?.end();
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('an install holding the start lock past both stale times keeps it: a waiting attach makes nothing, then starts once it’s dropped', {
  skip: SKIP,
}, async () => {
  const m = machines();
  /** @type {ReturnType<typeof attachCounting> | null} */
  let attach = null;
  const hold = join(m.root, 'hold');
  /** @type {Promise<unknown> | null} */
  let install = null;
  try {
    const { tar } = bundle({ version: VERSION });
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    const lock = hostPaths(m.home, VERSION).lock;
    const { done, pid } = await installPaused(m, tar, hold, 'HOLD');
    install = done;
    // Three minutes old, as an install checking turns or deleting a big folder, or suspended, could leave it: past
    // daemon.mjs’s LOCK_STALE_MS and the script’s own minute. Its owner is alive, so it’s held all the same.
    const old = new Date(Date.now() - 3 * 60_000);
    utimesSync(lock, old, old);
    attach = attachCounting(m.home);
    const a = attach;
    await until(() => a.state.waits >= 20 || a.state.spawned > 0);
    assert.equal(a.state.spawned, 0, 'the attach started no daemon');
    assert.equal(existsSync(code), false, 'and made nothing in the version’s folder');
    assert.deepEqual(readdirSync(join(root, 'locks')), [`${VERSION}.lock`], 'nor broke or replaced the lock');
    const owner = lockOwner(lock);
    assert.ok(installShell(owner?.pid, pid), 'which is still the install’s');
    // The script’s record is the one proc.mjs checks: PID, boot ID and start time where there’s /proc, else the PID.
    assert.equal(lockOwnerLive(parseLockOwner(readFileSync(join(lock, 'owner'), 'utf8'))), true, 'and names it as alive');
    if (existsSync('/proc/self/stat')) assert.deepEqual(owner, { pid: owner.pid, bootId: bootId(), startTime: startTime(owner.pid) });
    writeFileSync(hold, '');
    const r = await done;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `installed ${VERSION}\n`);
    // The install dropped its own lock; the attach then took one of its own and started the daemon.
    assert.ok(await until(() => a.state.spawned > 0), 'the attach went on once the install was done');
    assert.equal(a.state.spawned, 1);
    assert.deepEqual(lockOwner(lock), { pid: process.pid, bootId: bootId(), startTime: startTime(process.pid) });
    attach = null;
    assert.equal(await a.end(), 69);
    assert.deepEqual(readdirSync(join(root, 'locks')), [], 'and dropped it');
  } finally {
    await attach?.end();
    writeFileSync(hold, '');
    await install;
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a start lock whose owner is dead is broken at once, however new, by an install and by an attach', { skip: SKIP }, async () => {
  const m = machines();
  /** @type {ReturnType<typeof attachCounting> | null} */
  let attach = null;
  try {
    const { tar } = bundle({ version: VERSION });
    const root = join(m.home, '.postbox-remote');
    const lock = hostPaths(m.home, VERSION).lock;
    const deadLock = () => {
      mkdirSync(lock, { recursive: true, mode: 0o700 });
      writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: deadPid(), bootId: bootId(), startTime: 1 }));
    };
    deadLock();
    const r = installOnce(m, tar);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `installed ${VERSION}\n`);
    assert.deepEqual(top(root), [VERSION, 'locks'], 'the dead owner’s lock went, and the install dropped its own');
    // A PID alone, as the script writes it without /proc, is dead once that PID is.
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: deadPid() }));
    rmSync(join(root, VERSION), { recursive: true });
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    deadLock();
    attach = attachCounting(m.home);
    const a = attach;
    assert.ok(await until(() => a.state.spawned > 0), 'the attach broke it and started the daemon');
    assert.equal(a.state.waitsBefore, 0, 'without waiting for it to age');
    assert.equal(lockOwner(lock)?.pid, process.pid);
    attach = null;
    assert.equal(await a.end(), 69);
    assert.deepEqual(readdirSync(join(root, 'locks')), []);
  } finally {
    await attach?.end();
    rmSync(m.root, { recursive: true, force: true });
  }
});
