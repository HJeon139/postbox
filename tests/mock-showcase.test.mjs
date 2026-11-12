// The showcase replay (server/adapters/mock-showcase.mjs) writes a recording's app file in the room's project
// folder, by the name the recording gives: only a name that stays inside that folder.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { appPath } from '../server/adapters/mock-showcase.mjs';

test('a recording’s app file is written only inside the room’s folder', () => {
  const folder = join('/tmp', 'pb-room');
  assert.equal(appPath(folder, 'raft.html'), join(folder, 'raft.html'));
  assert.equal(appPath(folder, 'apps/raft.html'), join(folder, 'apps', 'raft.html'));
  for (const name of ['../raft.html', 'apps/../../raft.html', '/etc/hosts', '', '.', 'apps/..', 42, undefined])
    assert.equal(appPath(folder, /** @type {any} */ (name)), null, `${String(name)} is refused`);
});
