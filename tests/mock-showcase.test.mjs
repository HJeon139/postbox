// The showcase replay (server/adapters/mock-showcase.mjs) writes a recording's app file in the room's project
// folder, by the name the recording gives: only a name that stays inside that folder, symbolic links resolved.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appPath } from '../server/adapters/mock-showcase.mjs';
import { tempDir } from './temp-dirs.mjs';

test('a recording’s app file is written only inside the room’s folder', () => {
  const folder = realpathSync(tempDir('pb-room-'));
  mkdirSync(join(folder, 'apps'));
  assert.equal(appPath(folder, 'raft.html'), join(folder, 'raft.html'));
  assert.equal(appPath(folder, 'apps/raft.html'), join(folder, 'apps', 'raft.html'));
  for (const name of ['../raft.html', 'apps/../../raft.html', '/etc/hosts', '', '.', 'apps/..', 'missing/raft.html', 42, undefined])
    assert.equal(appPath(folder, /** @type {any} */ (name)), null, `${String(name)} is refused`);
});

test('a symbolic link inside the room’s folder doesn’t take the app file out of it', () => {
  const folder = realpathSync(tempDir('pb-room-'));
  const outside = realpathSync(tempDir('pb-outside-'));
  writeFileSync(join(outside, 'raft.html'), 'theirs');
  symlinkSync(outside, join(folder, 'out'));
  symlinkSync(join(outside, 'raft.html'), join(folder, 'raft.html'));
  assert.equal(appPath(folder, 'out/raft.html'), null, 'a folder linked from outside');
  assert.equal(appPath(folder, 'out/new.html'), null, 'a new file in a folder linked from outside');
  assert.equal(appPath(folder, 'raft.html'), null, 'a file linked from outside');
  symlinkSync(join(outside, 'later.html'), join(folder, 'later.html'));
  assert.equal(appPath(folder, 'later.html'), null, 'a link to a file outside that doesn’t exist yet');
  // The room’s own folder may be reached through a link: what counts is where it really is.
  const via = join(outside, 'room');
  symlinkSync(folder, via);
  assert.equal(appPath(via, 'app.html'), join(folder, 'app.html'));
});
