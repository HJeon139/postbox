import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateRunDir, makeWritable, removeAll, runBase, STALE_MS, sweep } from '../tools/gate-tmp.mjs';

const NOW = 1_800_000_000_000;
const DEAD = 4_000_001;
const LIVE = 4_000_002;
const UID = process.getuid?.() ?? 0;

/** A process.kill that knows which pids run: LIVE answers, EPERM_PID is another user’s, the rest have exited. */
function fakeKill(/** @type {number[]} */ alive = [LIVE], /** @type {number[]} */ eperm = []) {
  return (/** @type {number} */ pid, /** @type {number} */ sig) => {
    assert.equal(sig, 0);
    if (alive.includes(pid)) return true;
    const e = /** @type {NodeJS.ErrnoException} */ (new Error(eperm.includes(pid) ? 'EPERM' : 'ESRCH'));
    e.code = eperm.includes(pid) ? 'EPERM' : 'ESRCH';
    throw e;
  };
}

/** A folder standing in for the system temp folder, removed after the test, and the deps that point the gate at it. */
function scratch(/** @type {import('node:test').TestContext} */ t, over = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pb-gate-test-'));
  t.after(() => {
    makeWritable(fs, root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const tmp = join(root, 'tmp');
  fs.mkdirSync(tmp);
  return {
    root,
    tmp,
    deps: {
      fs,
      tmpdir: () => tmp,
      pid: process.pid,
      uid: UID,
      kill: fakeKill(),
      now: () => NOW,
      home: '/nonexistent-home',
      checkout: '/nonexistent-checkout',
      ...over,
    },
  };
}

/** A leftover run folder named for pid, with a file in it, last changed ageMs before NOW. */
function leftover(/** @type {string} */ tmp, /** @type {number} */ pid, ageMs = 2 * STALE_MS, tag = 'AbC123') {
  const dir = join(tmp, `pb-gate-${pid}-${tag}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(join(dir, 'f'), 'x');
  const at = (NOW - ageMs) / 1000;
  fs.utimesSync(dir, at, at);
  return dir;
}

test('the sweep removes a dead run’s folder older than an hour', (t) => {
  const { tmp, deps } = scratch(t);
  const dir = leftover(tmp, DEAD);
  sweep(deps);
  assert.equal(fs.existsSync(dir), false);
});

test('the sweep keeps a running gate’s folder however old it is', (t) => {
  const { tmp, deps } = scratch(t);
  const dir = leftover(tmp, LIVE, 100 * STALE_MS);
  sweep(deps);
  assert.equal(fs.existsSync(join(dir, 'f')), true);
});

test('the sweep keeps a folder whose pid answers EPERM: another user’s process still runs', (t) => {
  const { tmp, deps } = scratch(t, { kill: fakeKill([], [DEAD]) });
  const dir = leftover(tmp, DEAD);
  sweep(deps);
  assert.equal(fs.existsSync(dir), true);
});

test('the sweep keeps a folder whose pid answers any error but ESRCH, since only ESRCH says the run exited', (t) => {
  const kill = () => {
    const e = /** @type {NodeJS.ErrnoException} */ (new Error('EINVAL'));
    e.code = 'EINVAL';
    throw e;
  };
  const { tmp, deps } = scratch(t, { kill });
  const dir = leftover(tmp, DEAD);
  sweep(deps);
  assert.equal(fs.existsSync(dir), true);
});

test('the sweep keeps a dead run’s folder younger than an hour', (t) => {
  const { tmp, deps } = scratch(t);
  const dir = leftover(tmp, DEAD, STALE_MS - 60_000);
  sweep(deps);
  assert.equal(fs.existsSync(join(dir, 'f')), true);
});

test('the sweep keeps another user’s folder', (t) => {
  const { tmp, deps } = scratch(t, { uid: UID + 1 });
  const dir = leftover(tmp, DEAD);
  sweep(deps);
  assert.equal(fs.existsSync(join(dir, 'f')), true);
});

test('the sweep leaves a pb-gate symlink and the folder it points to alone', (t) => {
  const { root, tmp, deps } = scratch(t);
  const target = join(root, 'outside');
  fs.mkdirSync(target);
  fs.writeFileSync(join(target, 'keep'), 'x');
  const at = (NOW - 2 * STALE_MS) / 1000;
  fs.utimesSync(target, at, at);
  const link = join(tmp, `pb-gate-${DEAD}-LiNk01`);
  fs.symlinkSync(target, link);
  sweep(deps);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.existsSync(join(target, 'keep')), true);
});

test('the sweep leaves names that aren’t a gate run’s alone', (t) => {
  const { tmp, deps } = scratch(t);
  const other = join(tmp, `pb-${DEAD}-AbC123`);
  fs.mkdirSync(other);
  const at = (NOW - 2 * STALE_MS) / 1000;
  fs.utimesSync(other, at, at);
  sweep(deps);
  assert.equal(fs.existsSync(other), true);
});

test('the sweep leaves a name with more after the gate’s six characters alone', (t) => {
  const { tmp, deps } = scratch(t);
  const dir = leftover(tmp, DEAD, 2 * STALE_MS, 'AbC123x');
  sweep(deps);
  assert.equal(fs.existsSync(join(dir, 'f')), true);
});

test('without a user id, as on Windows, the sweep reads nothing and removes nothing', (t) => {
  const { tmp, deps } = scratch(t, { uid: undefined });
  const dir = leftover(tmp, DEAD);
  let reads = 0;
  const readdirSync = (/** @type {string} */ path) => {
    reads++;
    return fs.readdirSync(path);
  };
  const watched = { ...fs, readdirSync };
  assert.deepEqual(sweep({ ...deps, fs: /** @type {typeof fs} */ (watched) }), []);
  assert.equal(reads, 0);
  assert.equal(fs.existsSync(join(dir, 'f')), true);
});

test('a temp folder the sweep can’t read is skipped, and the run still opens its own', (t) => {
  const { deps } = scratch(t);
  const unreadable = {
    ...fs,
    readdirSync: () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
  };
  const d = { ...deps, fs: /** @type {typeof fs} */ (unreadable) };
  assert.deepEqual(sweep(d), []);
  const run = gateRunDir(d).open();
  t.after(() => removeAll(fs, run.path));
  assert.equal(fs.lstatSync(run.path).isDirectory(), true);
});

test('the sweep removes a dead run’s read-only folder, and its chmod walk never follows a link out of it', (t) => {
  const { root, tmp, deps } = scratch(t);
  const target = join(root, 'outside');
  fs.mkdirSync(target, { mode: 0o500 });
  fs.chmodSync(target, 0o500);
  const dir = leftover(tmp, DEAD);
  const inner = join(dir, 'inner');
  fs.mkdirSync(inner);
  fs.writeFileSync(join(inner, 'g'), 'x');
  fs.symlinkSync(target, join(inner, 'out'));
  fs.chmodSync(inner, 0o000);
  fs.chmodSync(dir, 0o500);
  const at = (NOW - 2 * STALE_MS) / 1000;
  fs.utimesSync(dir, at, at);
  sweep(deps);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.statSync(target).mode & 0o777, 0o500, 'the link’s target keeps its mode');
});

test('removing a run folder leaves a file outside it, hard-linked in, as read-only as it was', (t) => {
  const { root, deps } = scratch(t);
  const outside = join(root, 'outside-file');
  fs.writeFileSync(outside, 'x');
  fs.chmodSync(outside, 0o444);
  const run = gateRunDir(deps).open();
  fs.linkSync(outside, join(run.path, 'linked'));
  run.close();
  assert.equal(fs.existsSync(run.path), false, 'the run folder is gone');
  assert.equal(fs.statSync(outside).mode & 0o777, 0o444, 'the file outside keeps its mode (#815)');
});

test('a run folder is made under the system temp folder, named for the gate’s pid', (t) => {
  const { tmp, deps } = scratch(t);
  const run = gateRunDir(deps).open();
  t.after(() => run.close());
  assert.match(run.path, new RegExp(`^${tmp}/pb-gate-${process.pid}-[A-Za-z0-9]{6}$`));
  assert.equal(fs.lstatSync(run.path).isDirectory(), true);
});

test('closing a run removes its folder, a read-only one inside it too', (t) => {
  const { deps } = scratch(t);
  const run = gateRunDir(deps).open();
  fs.mkdirSync(join(run.path, 'ro'));
  fs.writeFileSync(join(run.path, 'ro', 'f'), 'x');
  fs.chmodSync(join(run.path, 'ro'), 0o500);
  run.close();
  assert.equal(fs.existsSync(run.path), false);
});

test('opening a run sweeps the leftovers of a killed one first', (t) => {
  const { tmp, deps } = scratch(t);
  const dir = leftover(tmp, DEAD);
  const run = gateRunDir(deps).open();
  t.after(() => run.close());
  assert.equal(fs.existsSync(dir), false);
});

test('the run folder never goes inside the checkout or the home folder, where a TMPDIR set there points', () => {
  assert.equal(runBase({ tmpdir: () => '/var/tmp', home: '/srv/u', checkout: '/srv/u/src/pb' }), '/var/tmp');
  assert.equal(runBase({ tmpdir: () => '/srv/u/src/pb/tmp', home: '/elsewhere', checkout: '/srv/u/src/pb' }), '/tmp');
  assert.equal(runBase({ tmpdir: () => '/srv/u/tmp', home: '/srv/u', checkout: '/w/pb' }), '/tmp');
  assert.equal(runBase({ tmpdir: () => '/srv/u', home: '/srv/u', checkout: '/w/pb' }), '/tmp');
  assert.equal(runBase({ tmpdir: () => '/srv/users', home: '/srv/u', checkout: '/w/pb' }), '/srv/users');
});
