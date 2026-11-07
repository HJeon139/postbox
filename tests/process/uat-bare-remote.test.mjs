// #852's confirmrun scenario seed (tools/uat/confirm-triggers.mjs): a commit and an origin that's a bare repository
// beside the workspace, so the scenario's push reaches it and never leaves the machine. It starts git, so it's here.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { seedBareRemote } from '../../tools/uat/confirm-triggers.mjs';
import { tempDir } from '../temp-dirs.mjs';

test('#852 the bare-remote seed gives a commit and an origin on this machine, which a push reaches', () => {
  const root = tempDir('pb-confirmrun-');
  const ws = join(root, 'ws');
  spawnSync('git', ['init', '-q', ws]);
  seedBareRemote(ws);
  const url = spawnSync('git', ['-C', ws, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(url, join(root, 'uat-remote.git'));
  const push = spawnSync('git', ['-C', ws, 'push', '-q', 'origin', 'HEAD:refs/heads/uat-confirm'], { encoding: 'utf8' });
  assert.equal(push.status, 0, push.stderr);
});
