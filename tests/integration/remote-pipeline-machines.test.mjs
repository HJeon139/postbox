// #899: onMachines reports the test’s own failure, not an error from its teardown, and teardown still ends what the
// test started when part of it fails (here, the stand-in’s trace folder gone before teardown reads it).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { alive, onMachines } from './remote-pipeline-machines.mjs';

const OWN = 'the test’s own failure';

test('#899 a test that fails, then a teardown that fails, reports the test’s failure with teardown’s error as its cause', async () => {
  await assert.rejects(
    onMachines({}, async (m) => {
      rmSync(m.trace, { recursive: true, force: true });
      throw new Error(OWN);
    }),
    (e) => {
      assert.equal(e.message, OWN);
      assert.equal(e.cause?.code, 'ENOENT', 'teardown’s error rides along as the cause');
      return true;
    },
  );
});

test('#899 a teardown that can’t read the trace still ends the daemon and removes the machine', async () => {
  let pid = 0;
  let root = '';
  // A stand-in daemon, short-lived so that even a regression can’t leave it for long.
  const daemon = spawn('sleep', ['5'], { stdio: 'ignore' });
  try {
    await assert.rejects(
      onMachines({}, async (m) => {
        root = m.root;
        mkdirSync(m.paths.code, { recursive: true });
        pid = daemon.pid ?? 0;
        writeFileSync(`${m.paths.code}/daemon.pid`, JSON.stringify({ pid }));
        rmSync(m.trace, { recursive: true, force: true });
      }),
      { code: 'ENOENT' },
    );
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, 'the daemon is ended though the trace was gone');
    assert.equal(existsSync(root), false, 'the machine’s folder is removed');
  } finally {
    // Assert first, then clean up, so a regression doesn’t leave the stand-in or the folder behind (#899’s own leak).
    try {
      process.kill(daemon.pid ?? 0, 'SIGKILL');
    } catch {}
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test('#899 a test that passes, then a teardown that fails, reports teardown’s error', async () => {
  // Passes on main: with nothing else failing, teardown’s error is the failure.
  await assert.rejects(
    onMachines({}, async (m) => {
      rmSync(m.trace, { recursive: true, force: true });
    }),
    { code: 'ENOENT' },
  );
});
