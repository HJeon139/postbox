// #585: the conformance probe’s codex app-server client and version reader, against real processes: shell scripts
// standing in for codex, which start in milliseconds. One reads nothing and answers nothing, as a CLI stuck at a
// prompt of its own would: the client stops it when initialize gets no answer, since nothing else holds it then and a
// live child keeps the tool from exiting. One answers initialize and exits: the wait for its turn fails at once.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openAppServer } from '../../tools/conformance/app-server.mjs';
import { cliVersion } from '../../tools/conformance/run.mjs';
import { tempDir } from '../temp-dirs.mjs';

/** Whether a process is still running. @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a codex that never answers initialize is stopped, and the open fails saying why', async () => {
  const dir = tempDir('conformance-app-server-');
  const bin = join(dir, 'silent-codex');
  const pidFile = join(dir, 'pid');
  // A shell stand-in starts in milliseconds, so the pid is written long before initialize gives up on it.
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 60\n`);
  chmodSync(bin, 0o755);
  await assert.rejects(openAppServer({ bin, cwd: dir, env: { PATH: process.env.PATH ?? '' }, requestMs: 500 }), /initialize got no answer/);
  assert.ok(existsSync(pidFile), 'the stand-in started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(alive(pid), false, 'the app-server is stopped once initialize fails');
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('a codex that answers initialize and then exits fails the wait for its turn at once', async () => {
  const dir = tempDir('conformance-app-server-');
  const bin = join(dir, 'brief-codex');
  writeFileSync(bin, '#!/bin/sh\nread line\necho \'{"id":1,"result":{}}\'\nexit 0\n');
  chmodSync(bin, 0o755);
  const server = await openAppServer({ bin, cwd: dir, env: { PATH: process.env.PATH ?? '' }, requestMs: 60_000 });
  try {
    const started = Date.now();
    await assert.rejects(server.notified('turn/completed'), /exited before turn\/completed/);
    assert.ok(Date.now() - started < 10_000, 'it failed when the process exited, not after its 60 s wait');
  } finally {
    await server.stop();
  }
});

test('a CLI’s version is its whole --version line, and a CLI that can’t run has none', async () => {
  const dir = tempDir('conformance-cli-');
  const bin = join(dir, 'fake-cli');
  writeFileSync(bin, '#!/bin/sh\necho "fake-cli 1.2.3"\n');
  chmodSync(bin, 0o755);
  assert.equal(await cliVersion(bin), 'fake-cli 1.2.3');
  assert.equal(await cliVersion(join(dir, 'no-such-cli')), null);
});
