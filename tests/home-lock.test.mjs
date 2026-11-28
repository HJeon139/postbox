// The command line’s claim on a data folder under races (server/home.mjs, lockData; #2027): a stale lock taken over
// under a takeover file, so two starters that read the same dead pid can’t both claim the folder. Every pid a test
// writes is positive: the parent process (the test runner) stands for a live holder, and 2147483646 for one that’s gone.

import assert from 'node:assert/strict';
import { linkSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { lockData } from '../server/home.mjs';
import { tempDir } from './temp-dirs.mjs';

const DEAD = '2147483646';
const realIo = { writeFileSync, linkSync, readFileSync, rmSync };

test('two starters over one dead lock: the second finds the first’s live lock when it takes over, and is refused (#2027)', () => {
  const dir = tempDir('pb-home-lock-');
  const lock = join(dir, 'postbox.lock');
  writeFileSync(lock, DEAD);
  let firstRan = false;
  const io = {
    ...realIo,
    linkSync(src, dest) {
      if (dest === `${lock}.taking` && !firstRan) {
        // The first starter, which read the same dead pid, finishes its takeover here: it removed the dead lock and
        // linked its own. This starter read the dead pid before that.
        firstRan = true;
        rmSync(lock);
        writeFileSync(lock, String(process.ppid));
      }
      return linkSync(src, dest);
    },
  };
  assert.throws(() => lockData(dir, io), new RegExp(`Another Postbox \\(process ${process.ppid}\\) is using`));
  assert.equal(firstRan, true, 'the interleaving ran');
  assert.equal(readFileSync(lock, 'utf8'), String(process.ppid), 'the first starter’s lock stays');
  assert.deepEqual(readdirSync(dir), ['postbox.lock'], 'no takeover file or draft is left');
});

test('a takeover already under way refuses a second at once, naming the file, and removes nothing (#2027)', () => {
  const dir = tempDir('pb-home-lock-');
  const lock = join(dir, 'postbox.lock');
  writeFileSync(lock, DEAD);
  writeFileSync(`${lock}.taking`, String(process.ppid));
  assert.throws(
    () => lockData(dir),
    (e) => {
      assert.match(e.message, /Another Postbox start is taking over/);
      assert.ok(e.message.includes(`${lock}.taking`), `names the file: ${e.message}`);
      return true;
    },
  );
  assert.deepEqual(readdirSync(dir).sort(), ['postbox.lock', 'postbox.lock.taking'], 'neither file was removed');
  assert.equal(readFileSync(lock, 'utf8'), DEAD);
});

test('a dead lock is taken over, and the takeover file goes with it (#2027)', () => {
  const dir = tempDir('pb-home-lock-');
  const lock = join(dir, 'postbox.lock');
  writeFileSync(lock, DEAD);
  const release = lockData(dir);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  assert.deepEqual(readdirSync(dir), ['postbox.lock'], 'no takeover file or draft is left');
  release();
});

test('a release leaves a lock another start took over meanwhile: only this run’s lock goes (#2027)', () => {
  const dir = tempDir('pb-home-lock-');
  const lock = join(dir, 'postbox.lock');
  const release = lockData(dir);
  writeFileSync(lock, String(process.ppid)); // as a takeover by another start leaves it
  release();
  assert.equal(readFileSync(lock, 'utf8'), String(process.ppid), 'not this run’s lock: left alone');
  rmSync(lock);
  lockData(dir)();
  assert.deepEqual(readdirSync(dir), [], 'its own lock goes');
});

test('a draft whose write fails after the open is removed, and the error is raised as is (#2027)', () => {
  const dir = tempDir('pb-home-lock-');
  const io = {
    ...realIo,
    writeFileSync(path, _data, opts) {
      writeFileSync(path, '', opts); // the open made the file; the write then fails, as on a full disk
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    },
  };
  assert.throws(() => lockData(dir, io), { code: 'ENOSPC' });
  assert.deepEqual(readdirSync(dir), [], 'no draft is left behind');
});

test('once the lock is held, drafts older than 10 s that a dead start left are swept, and fresh ones are left (#2027)', () => {
  const dir = tempDir('pb-home-lock-');
  const old = Date.now() / 1000 - 60;
  for (const name of ['postbox.lock.4242.0a0b0c0d.new', 'postbox.lock.taking.4242.0a0b0c0d.new']) {
    writeFileSync(join(dir, name), '4242');
    utimesSync(join(dir, name), old, old);
  }
  writeFileSync(join(dir, 'postbox.lock.4343.0e0f0a0b.new'), '4343'); // a starter mid-publish
  writeFileSync(join(dir, 'notes.new'), 'not a lock’s'); // not a draft of the lock
  const release = lockData(dir);
  assert.deepEqual(readdirSync(dir).sort(), ['notes.new', 'postbox.lock', 'postbox.lock.4343.0e0f0a0b.new']);
  release();
});
