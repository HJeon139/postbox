// #899: onMachines reports the test’s own failure, not an error from its teardown, and teardown still ends what the
// test started when part of it fails (here, the stand-in’s trace folder gone before teardown reads it).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { alive, daemonPid, machine, onMachines, standins } from './remote-pipeline-machines.mjs';

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
    // Only a started stand-in: a pid of 0 would SIGKILL this test’s own process group (#2012).
    if (daemon.pid) {
      try {
        process.kill(daemon.pid, 'SIGKILL');
      } catch {}
    }
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

test('#2028 standins, daemonPid and alive reject non-positive, PID 1 and out-of-range PIDs', () => {
  const m = machine({});
  try {
    mkdirSync(m.paths.code, { recursive: true });
    const line = `${JSON.stringify({ ev: 'start', at: 1 })}\n`;
    writeFileSync(`${m.trace}/0.jsonl`, line);
    writeFileSync(`${m.trace}/1.jsonl`, line);
    writeFileSync(`${m.trace}/012345.jsonl`, line);
    writeFileSync(`${m.trace}/2147483648.jsonl`, line);
    writeFileSync(`${m.trace}/12345.jsonl`, line);
    assert.deepEqual(
      standins(m).map((s) => s.pid),
      [12345],
      'standins ignores 0, 1, leading-zero, and > 32-bit max filenames',
    );

    for (const bad of [0, 1, -1, 1.5, '123', null, undefined, 0x80000000]) {
      writeFileSync(`${m.paths.code}/daemon.pid`, JSON.stringify({ pid: bad }));
      assert.equal(daemonPid(m), null, `daemonPid rejects ${JSON.stringify(bad)}`);
    }
    writeFileSync(`${m.paths.code}/daemon.pid`, JSON.stringify({ pid: 43210 }));
    assert.equal(daemonPid(m), 43210, 'daemonPid returns a valid child PID');

    for (const bad of [0, -1, 1.5, Number.NaN, 0x80000000]) {
      assert.equal(alive(bad), false, `alive(${bad}) is false`);
    }
  } finally {
    delete process.env.POSTBOX_CLAUDE_RECORD;
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('#2028 teardown ignores invalid stand-in, shim and daemon PIDs without signaling them', async () => {
  let machineRef;
  await onMachines({}, async (m) => {
    machineRef = m;
    mkdirSync(m.paths.code, { recursive: true });
    writeFileSync(`${m.trace}/0.jsonl`, `${JSON.stringify({ ev: 'start', at: 1 })}\n`);
    writeFileSync(`${m.trace}/2147483646.jsonl`, `${JSON.stringify({ ev: 'start', at: 2 })}\n${JSON.stringify({ ev: 'shim', pid: -2 })}\n`);
    writeFileSync(`${m.paths.code}/daemon.pid`, JSON.stringify({ pid: -3 }));
    m.pids.set(0, 'bad zero');
    m.pids.set(0x80000000, 'overflow');
  });
  assert.equal(machineRef.pids.has(-2), false, 'teardown did not record a negative shim PID');
  assert.equal(machineRef.pids.has(-3), false, 'teardown did not record a negative daemon PID');
});
