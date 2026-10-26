// The host daemon’s locks (server/remote/host/daemon.mjs, #120): daemon.pid, which a serve holds for its life, and
// the start lock an attach or install holds, judged by its owner, with the break locks that let one stale lock be
// removed at a time. Over temp folders with fake process checks (tests/remote-daemon-setup.mjs).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { LOCK_FRESH_MS } from '../server/remote/host/cleanup.mjs';
import { dropLock, EXIT, LOCK_STALE_MS, SERVE_START_MS, takeDaemonLock, takeLock } from '../server/remote/host/daemon.mjs';
import { hostPaths } from '../shared/remote-protocol.mjs';
import { attachOnce, BOOT, VERSION, waitFor } from './remote-daemon-setup.mjs';

test('takeDaemonLock: daemon.pid is taken once; a live holder’s is kept, and a dead one’s or a garbled one is replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbl-'));
  try {
    const file = join(dir, 'daemon.pid');
    const live = new Set();
    const proc = { bootId: () => BOOT, startTime: () => 55, sameProcess: (r) => live.has(r.pid) };
    const a = takeDaemonLock(dir, proc);
    assert.equal(a.held, true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { pid: process.pid, bootId: BOOT, startTime: 55 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    live.add(process.pid);
    const b = takeDaemonLock(dir, proc);
    assert.equal(b.held, false);
    assert.equal(b.held === false && b.code, EXIT.ok);
    assert.match(b.held === false ? b.why : '', /already serves this version/);
    if (a.held) a.release();
    assert.throws(() => statSync(file), /ENOENT/, 'release removes it');

    for (const stale of [JSON.stringify({ pid: 999_999, bootId: BOOT, startTime: 1 }), '{"pid":']) {
      writeFileSync(file, stale);
      const c = takeDaemonLock(dir, proc);
      assert.equal(c.held, true, stale);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
      // Another serve’s by the time this one releases: it stays.
      writeFileSync(file, stale);
      if (c.held) c.release();
      assert.equal(readFileSync(file, 'utf8'), stale);
    }
    assert.deepEqual(readdirSync(dir), ['daemon.pid'], 'no temporary file or break lock is left');
    assert.equal(takeDaemonLock(dir, { ...proc, startTime: () => null }).held, false, 'no start time, no lock it could check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeDaemonLock: a serve paused while it removes a dead daemon’s daemon.pid keeps daemon.pid.break past its age; another serve neither breaks it nor takes daemon.pid, then takes it once it’s free; a dead serve’s break lock is broken at once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbl-'));
  try {
    const file = join(dir, 'daemon.pid');
    const brk = `${file}.break`;
    const stale = JSON.stringify({ pid: 999_999, bootId: BOOT, startTime: 1 });
    // Two serves in this one process, told apart by their start times; both are alive.
    const sameProcess = (r) => r.pid === process.pid && r.bootId === BOOT && (r.startTime === 55 || r.startTime === 56);
    const proc = { bootId: () => BOOT, startTime: () => 55, sameProcess };
    const other = { ...proc, startTime: () => 56 };
    const otherText = JSON.stringify({ pid: process.pid, bootId: BOOT, startTime: 56 });
    const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
    writeFileSync(file, stale);
    /** What the other serve did and found while this one was paused. @type {any} */
    let during = null;
    const paused = () => {
      // Suspended a minute, far past the break lock’s age limit.
      const old = new Date(Date.now() - 60_000);
      utimesSync(brk, old, old);
      const b = takeDaemonLock(dir, other);
      during = { held: b.held, pid: read(file), brk: read(`${brk}/owner`) };
      if (b.held) b.release();
    };
    const a = takeDaemonLock(dir, { ...proc, paused });
    assert.ok(during, 'the first serve paused');
    assert.equal(during.held, false, 'the other serve didn’t take daemon.pid');
    assert.equal(during.pid, stale, 'nor remove the dead daemon’s');
    assert.equal(during.brk, JSON.stringify({ pid: process.pid, bootId: BOOT, startTime: 55 }), 'nor break the paused serve’s break lock');
    assert.equal(a.held, true, 'the paused serve went on and took daemon.pid');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).startTime, 55);
    assert.equal(takeDaemonLock(dir, other).held, false);
    if (a.held) a.release();
    const b = takeDaemonLock(dir, other);
    assert.equal(b.held, true, 'once it’s free, the next serve takes it');
    assert.equal(readFileSync(file, 'utf8'), otherText);
    if (b.held) b.release();
    // A break lock whose serve died holding it, or with a garbled record, is broken at once, however new.
    for (const owner of [stale, '{"pid":']) {
      writeFileSync(file, stale);
      mkdirSync(brk);
      writeFileSync(`${brk}/owner`, owner);
      const c = takeDaemonLock(dir, proc);
      assert.equal(c.held, true, owner);
      if (c.held) c.release();
    }
    assert.deepEqual(readdirSync(dir), [], 'no temporary file or break lock is left');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host attach judges the start lock by its owner: a live one is waited for however old, a dead or garbled one or one long without a record is broken', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pba-'));
  try {
    const p = hostPaths(home, VERSION);
    // Every lock looks long past LOCK_STALE_MS to this clock; only PID 4242 is alive, as its record says.
    let clock = Date.now() + 10 * LOCK_STALE_MS;
    const proc = { bootId: () => BOOT, startTime: () => 5, sameProcess: (r) => r.pid === 4242 && r.bootId === BOOT && r.startTime === 5 };
    /** A lock with `text` as its owner record, or none. @param {string | null} text */
    const held = (text) => {
      mkdirSync(p.lock, { recursive: true, mode: 0o700 });
      if (text !== null) writeFileSync(`${p.lock}/owner`, text);
    };
    /** An attach over that lock: how often it waited before it took it. */
    const run = async (/** @type {number} */ until) => {
      let waits = 0;
      const { code, spawned } = await attachOnce(
        home,
        async () => {
          waits++;
          assert.equal(existsSync(p.code), false, 'no version folder made without the lock');
          if (waits === until) rmSync(p.lock, { recursive: true });
        },
        { proc, now: () => clock },
      );
      assert.equal(code, EXIT.ok);
      assert.equal(spawned.length, 1);
      await waitFor(() => !existsSync(p.lock));
      rmSync(p.code, { recursive: true });
      return waits;
    };
    held(JSON.stringify({ pid: 4242, bootId: BOOT, startTime: 5 }));
    assert.equal(await run(3), 3, 'a live owner’s lock is waited for until it’s dropped, however old');
    for (const text of [
      JSON.stringify({ pid: 4242, bootId: BOOT, startTime: 6 }),
      JSON.stringify({ pid: 4243, bootId: BOOT, startTime: 5 }),
      '{"pid":',
      null,
    ]) {
      held(text);
      assert.equal(await run(-1), 0, `broken at once: ${text}`);
      assert.deepEqual(readdirSync(dirname(p.lock)), [], 'nothing set aside is left');
    }
    // One with no record yet, as one just made, is waited for while it’s fresh.
    clock = Date.now();
    held(null);
    assert.equal(await run(2), 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The rest of the paused-breaker test below, from where its clock stands: break locks that are broken at once, held
 * while fresh, or taken by another meanwhile.
 */
function breakLockCases({ lock, brk, a, b, dead, proc, read, deadLock }, at) {
  let clock = at;
  const now = () => clock;
  // A break lock whose breaker died holding it, or with a garbled record, is broken at once, however new.
  for (const owner of [dead, '{"pid":']) {
    deadLock();
    mkdirSync(brk);
    writeFileSync(`${brk}/owner`, owner);
    assert.equal(takeLock(lock, b, now, proc), true, owner);
    dropLock(lock, b);
  }
  // One with no record (something else in it; none of ours is ever there without one) is held while it’s fresh,
  // and broken after.
  clock = Date.now();
  deadLock();
  mkdirSync(brk);
  writeFileSync(`${brk}/stray`, '');
  assert.equal(takeLock(lock, b, now, proc), false, 'a fresh break lock with no record is held');
  clock += LOCK_STALE_MS;
  assert.equal(takeLock(lock, b, now, proc), true, 'and broken once it’s old');
  dropLock(lock, b);
  // A breaker whose break lock was broken and taken meanwhile leaves the new one.
  deadLock();
  const theirs = () => {
    rmSync(brk, { recursive: true });
    mkdirSync(brk);
    writeFileSync(`${brk}/owner`, b);
  };
  takeLock(lock, a, now, { ...proc, paused: theirs });
  assert.equal(read(`${brk}/owner`), b, 'the other’s break lock stays');
  assert.deepEqual(readdirSync(brk), ['owner']);
}

test('a breaker paused between finding the start lock stale and removing it keeps <lock>.break past every age: another attach neither breaks it nor enters, then goes on once it’s free; a dead breaker’s is broken at once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbk-'));
  try {
    const lock = join(dir, 'locks', `${VERSION}.lock`);
    const brk = `${lock}.break`;
    const record = (/** @type {number} */ pid) => JSON.stringify({ pid, bootId: BOOT, startTime: 5 });
    // Two attaches, 4242 and 4243, both alive; 4244 died holding the start lock.
    const [a, b, dead] = [record(4242), record(4243), record(4244)];
    const proc = { bootId: () => BOOT, startTime: () => 5, sameProcess: (r) => (r.pid === 4242 || r.pid === 4243) && r.bootId === BOOT && r.startTime === 5 };
    let clock = Date.now();
    const now = () => clock;
    const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
    const deadLock = () => {
      mkdirSync(lock, { recursive: true, mode: 0o700 });
      writeFileSync(`${lock}/owner`, dead);
    };
    deadLock();
    /** What the other attach did and found while the breaker was paused. @type {any} */
    let during = null;
    const paused = () => {
      // Suspended far past the break lock’s age limit and the start lock’s. The other attach tries as its loop would.
      clock += 10 * LOCK_STALE_MS;
      const took = [0, 1, 2, 3, 4].map(() => takeLock(lock, b, now, proc));
      during = { took, lock: read(`${lock}/owner`), brk: read(`${brk}/owner`) };
    };
    assert.equal(takeLock(lock, a, now, { ...proc, paused }), true, 'the paused breaker went on and took the lock');
    assert.ok(during, 'it paused');
    assert.deepEqual(during.took, [false, false, false, false, false], 'the other attach never took the lock');
    assert.equal(during.lock, dead, 'nor removed the dead one’s');
    assert.equal(during.brk, a, 'nor broke the paused breaker’s break lock');
    assert.equal(read(`${lock}/owner`), a);
    assert.deepEqual(readdirSync(dirname(lock)), [`${VERSION}.lock`], 'the breaker dropped its break lock, and nothing set aside is left');
    assert.equal(takeLock(lock, b, now, proc), false);
    dropLock(lock, a);
    assert.equal(takeLock(lock, b, now, proc), true, 'once it’s free, the next attach takes it');
    dropLock(lock, b);
    breakLockCases({ lock, brk, a, b, dead, proc, read, deadLock }, clock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the start lock goes stale before an install’s minute-granular test would take it, and cleanup agrees', () => {
  assert.ok(LOCK_STALE_MS > SERVE_START_MS, 'an attach holds it for up to SERVE_START_MS');
  assert.ok(LOCK_STALE_MS <= 60_000, 'install.mjs’s script takes a lock for stale after find -mmin +1, a minute');
  assert.equal(LOCK_FRESH_MS, LOCK_STALE_MS);
});
