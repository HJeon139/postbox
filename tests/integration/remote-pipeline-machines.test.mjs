// #899: onMachines reports the test’s own failure, not an error from its teardown, and teardown still ends what the
// test started when part of it fails (here, the stand-in’s trace folder gone before teardown reads it).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { goneVia } from './host.mjs';
import { alive, daemonPid, machine, onMachines, standins, teardown } from './remote-pipeline-machines.mjs';

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

test('#2028 standins, daemonPid and goneVia reject non-positive, PID 1 and out-of-range PIDs, and goneVia signals none of them', () => {
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

    const calls = [];
    for (const bad of [0, -1, -2, 1.5, Number.NaN, 0x80000000]) {
      assert.equal(
        goneVia(bad, (...args) => calls.push(args)),
        true,
        `goneVia(${bad}) is true`,
      );
    }
    assert.deepEqual(calls, [], 'no value that can’t be a PID is signaled, even with signal 0');
  } finally {
    delete process.env.POSTBOX_CLAUDE_RECORD;
    rmSync(m.root, { recursive: true, force: true });
  }
});

/**
 * A fake `kill` that records each call and never reaches a real process (§10.22). Signal 0 finds no process, as a
 * real one finds none for a PID that isn’t running.
 */
function fakeKill() {
  /** @type {[number, string | number][]} */
  const calls = [];
  const kill = (/** @type {number} */ pid, /** @type {string | number} */ signal) => {
    calls.push([pid, signal]);
    if (signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  };
  return { calls, kill };
}

// Valid PIDs that no real system hands out (macOS stops below 100,000, Linux at 4,194,304), so even a guard that’s
// broken and a fake that’s bypassed can’t reach a process.
const NEVER = 0x7fffffff;
const NEVER_TOO = 0x7ffffffe;

test('#2028 teardown signals no stand-in, shim, daemon or stray PID that can’t be a child: 0, 1, negative or too big', async () => {
  const m = machine({});
  try {
    mkdirSync(m.paths.code, { recursive: true });
    const start = `${JSON.stringify({ ev: 'start', at: 1 })}\n`;
    const shim = (/** @type {number} */ pid) => `${JSON.stringify({ ev: 'shim', pid })}\n`;
    for (const name of ['0', '1', '2147483648']) writeFileSync(`${m.trace}/${name}.jsonl`, start);
    // A stand-in’s trace gives one shim, its first, so each bad shim needs a valid stand-in of its own.
    writeFileSync(`${m.trace}/${NEVER_TOO}.jsonl`, `${start}${shim(1)}`);
    writeFileSync(`${m.trace}/${NEVER}.jsonl`, `${start}${shim(-2)}`);
    writeFileSync(`${m.paths.code}/daemon.pid`, JSON.stringify({ pid: 1 }));
    for (const bad of [0, 1, -1, -2, 1.5, 0x80000000]) m.pids.set(bad, `bad ${bad}`);
    const { calls, kill } = fakeKill();
    await teardown(m, [], { kill, waitMs: 0 });
    assert.deepEqual(
      new Set(calls.map(String)),
      new Set([String([NEVER, 0]), String([NEVER_TOO, 0])]),
      'the two valid stand-ins are looked at with signal 0, and nothing else is signaled',
    );
  } finally {
    delete process.env.POSTBOX_CLAUDE_RECORD;
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('#2028 teardown sends its signals through the kill it’s given: SIGTERM to the daemon, SIGKILL to a stray’s group and itself', async () => {
  const m = machine({});
  try {
    mkdirSync(m.paths.code, { recursive: true });
    writeFileSync(`${m.paths.code}/daemon.pid`, JSON.stringify({ pid: NEVER }));
    m.pids.set(NEVER_TOO, 'a stray');
    const { calls, kill } = fakeKill();
    const strays = await teardown(m, [], { kill, isGone: (pid) => pid !== NEVER_TOO, waitMs: 0 });
    assert.deepEqual(strays, [`a stray (${NEVER_TOO})`]);
    assert.deepEqual(calls, [
      [NEVER, 'SIGTERM'],
      [-NEVER_TOO, 'SIGKILL'],
      [NEVER_TOO, 'SIGKILL'],
    ]);
  } finally {
    delete process.env.POSTBOX_CLAUDE_RECORD;
    rmSync(m.root, { recursive: true, force: true });
  }
});
