// The turn runner on a remote host (#120, H1): server/remote/host/runner.mjs’s launchRunner and logindFacts, and
// proc.mjs, with injected facts, so nothing is spawned. The real runner on a stand-in harness, with real files and a
// real Unix socket, is in tests/integration/remote-runner.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PROGRAMS } from '../server/remote/host/paths.mjs';
import {
  bootId,
  listProcesses,
  liveGroups,
  parsePs,
  parseStartTime,
  parseStat,
  sameProcess,
  startTime,
  toolGroups,
  zombie,
} from '../server/remote/host/proc.mjs';
import { launchRunner, logindFacts } from '../server/remote/host/runner.mjs';
import { hostPaths } from '../shared/remote-protocol.mjs';

const NO_PROC = process.platform !== 'linux' && 'needs /proc, which only Linux has; macOS reads the same facts through sysctl and ps';

// ── launchRunner and logind ──────────────────────────────────────────────────────────

/** A spawn that records its call. */
/** @param {{ pid?: number }} [opts] */
function fakeSpawn(opts = {}) {
  const pid = 'pid' in opts ? opts.pid : 4242;
  const calls = [];
  let unrefd = false;
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { pid, on() {}, unref: () => (unrefd = true) };
  };
  return { spawn: /** @type {any} */ (spawn), calls, unrefd: () => unrefd };
}

const P = hostPaths('/home/user', '0.10.0');

test('launchRunner: where logind kills at logout, the runner goes into a systemd user scope', () => {
  const f = fakeSpawn();
  const r = launchRunner({ node: '/usr/bin/node', turn: 't1', paths: P, spawn: f.spawn, logind: () => ({ killUserProcesses: true, linger: false }) });
  assert.deepEqual(r, { pid: 4242, scoped: true, lingerOff: true });
  assert.equal(f.calls[0].cmd, 'systemd-run');
  assert.deepEqual(f.calls[0].args, ['--user', '--scope', '--quiet', '--', '/usr/bin/node', PROGRAMS.runner, 't1']);
  assert.deepEqual(f.calls[0].opts, { cwd: '/home/user/.postbox-remote/turns/t1', detached: true, stdio: 'ignore' });
  assert.equal(f.unrefd(), true);
});

test('launchRunner: without KillUserProcesses, or when logind doesn’t say, it’s its own session only', () => {
  for (const facts of [
    { killUserProcesses: false, linger: true },
    { killUserProcesses: null, linger: null },
  ]) {
    const f = fakeSpawn();
    const r = launchRunner({ node: '/usr/bin/node', turn: 't1', paths: P, spawn: f.spawn, logind: () => facts });
    assert.equal(r.scoped, false);
    assert.equal(r.lingerOff, false);
    assert.equal(f.calls[0].cmd, '/usr/bin/node');
    assert.deepEqual(f.calls[0].args, [PROGRAMS.runner, 't1']);
    assert.equal(f.calls[0].opts.detached, true);
  }
});

test('launchRunner: detach setsid never asks logind or uses a scope', () => {
  const f = fakeSpawn();
  const r = launchRunner({
    node: '/usr/bin/node',
    turn: 't1',
    paths: P,
    scope: 'setsid',
    spawn: f.spawn,
    logind: () => assert.fail('logind was asked'),
  });
  assert.equal(r.scoped, false);
  assert.equal(f.calls[0].cmd, '/usr/bin/node');
});

test('launchRunner: a turn ID that isn’t one is refused before anything starts', () => {
  const f = fakeSpawn();
  assert.throws(
    () => launchRunner({ node: '/usr/bin/node', turn: '../x', paths: P, spawn: f.spawn, logind: () => ({ killUserProcesses: null, linger: null }) }),
    /isn’t a turn ID/,
  );
  assert.equal(f.calls.length, 0);
});

test('launchRunner: a spawn with no pid throws', () => {
  const f = fakeSpawn({ pid: undefined });
  assert.throws(
    () => launchRunner({ node: '/nope/node', turn: 't1', paths: P, spawn: f.spawn, logind: () => ({ killUserProcesses: null, linger: null }) }),
    /didn’t start/,
  );
});

test('logindFacts: reads KillUserProcesses from busctl and Linger from loginctl show-user', () => {
  // The shapes a probe recorded on two Linux hosts (busctl `b false`, loginctl `Linger=yes` and `Linger=no`).
  const calls = [];
  const run = (outs) => (file, args) => {
    calls.push([file, ...args]);
    const v = outs[file];
    if (v instanceof Error) throw v;
    return v;
  };
  assert.deepEqual(logindFacts({ uid: 1000, run: run({ busctl: 'b true\n', loginctl: 'Linger=no\n' }) }), { killUserProcesses: true, linger: false });
  assert.deepEqual(calls, [
    ['busctl', 'get-property', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'KillUserProcesses'],
    ['loginctl', 'show-user', '1000', '--property=Linger'],
  ]);
  assert.deepEqual(logindFacts({ uid: 1000, run: run({ busctl: 'b false\n', loginctl: 'Linger=yes\n' }) }), { killUserProcesses: false, linger: true });
  assert.deepEqual(logindFacts({ uid: 1000, run: run({ busctl: new Error('ENOENT'), loginctl: new Error('not logged in') }) }), {
    killUserProcesses: null,
    linger: null,
  });
  assert.deepEqual(logindFacts({ uid: 1000, run: run({ busctl: 'garbage', loginctl: 'Linger=maybe' }) }), { killUserProcesses: null, linger: null });
});

// ── proc.mjs ─────────────────────────────────────────────────────────────────────────

// A /proc/<pid>/stat line from a Linux host, with comm changed to one that has spaces and “) (” in it. Field 22,
// the start time, is 98765.
const STAT =
  '4321 (a) (b c) S 1 4321 4321 0 -1 4194560 120 0 0 0 1 2 0 0 20 0 1 0 98765 1234567 890 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';

test('proc: the start time is field 22, counted from the last paren of comm', () => {
  assert.equal(parseStartTime(STAT), 98765);
  assert.equal(parseStartTime('1 (plain) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 55 0 0'), 55);
  assert.equal(parseStartTime('no parens'), null);
  assert.equal(parseStartTime('1 (short) S 0 1'), null);
  const readFile = (path) => {
    assert.equal(path, '/proc/4321/stat');
    return STAT;
  };
  assert.equal(startTime(4321, { platform: 'linux', readFile }), 98765);
  assert.equal(
    startTime(4321, {
      platform: 'linux',
      readFile: () => {
        throw new Error('ENOENT');
      },
    }),
    null,
  );
  assert.equal(startTime(0, { platform: 'linux', readFile }), null);
});

test('proc: the boot ID is /proc’s on Linux, sysctl’s on macOS, and null when it isn’t a UUID', () => {
  const id = 'c289b1d7-f351-40ee-a182-de97532ef9d9';
  assert.equal(bootId({ platform: 'linux', readFile: () => `${id}\n` }), id);
  assert.equal(bootId({ platform: 'darwin', run: () => `${id.toUpperCase()}\n` }), id);
  assert.equal(bootId({ platform: 'linux', readFile: () => 'nope' }), null);
  assert.equal(
    bootId({
      platform: 'linux',
      readFile: () => {
        throw new Error('ENOENT');
      },
    }),
    null,
  );
});

test('proc: sameProcess needs the PID alive and both the boot ID and the start time to match', () => {
  const id = 'c289b1d7-f351-40ee-a182-de97532ef9d9';
  const files = { '/proc/sys/kernel/random/boot_id': `${id}\n`, '/proc/4321/stat': STAT };
  const opts = { platform: 'linux', readFile: (p) => files[p], kill: () => true };
  const rec = { pid: 4321, bootId: id, startTime: 98765 };
  assert.equal(sameProcess(rec, opts), true);
  assert.equal(sameProcess({ ...rec, startTime: 98766 }, opts), false, 'another process with the same PID');
  assert.equal(sameProcess({ ...rec, bootId: id.replace('c', 'd') }, opts), false, 'another boot');
  // A zombie still takes signal 0 and keeps its start time, but it runs nothing: a killed daemon nobody reaps.
  const asZombie = STAT.replace(/\) [A-Z] /, ') Z ');
  assert.notEqual(asZombie, STAT, 'the fixture names a state to change');
  assert.equal(sameProcess(rec, { ...opts, readFile: (p) => ({ ...files, '/proc/4321/stat': asZombie })[p] }), false, 'a zombie isn’t alive');
  assert.equal(zombie(4321, { platform: 'darwin', run: () => 'Z\n' }), true, 'on macOS, ps’s state');
  assert.equal(zombie(4321, { platform: 'darwin', run: () => 'S+\n' }), false);
  const gone = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  assert.equal(
    sameProcess(rec, {
      ...opts,
      kill: () => {
        throw gone;
      },
    }),
    false,
  );
});

test('proc: on this Linux host, the facts come from /proc', { skip: NO_PROC }, () => {
  assert.equal(bootId(), readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  assert.equal(startTime(process.pid), parseStartTime(readFileSync('/proc/self/stat', 'utf8')));
  assert.equal(startTime(2 ** 31 - 1), null);
});

// ── proc.mjs: a turn’s tool shells ───────────────────────────────────────────────────

/** A /proc/<pid>/stat line with the fields Stop reads: ppid, pgid and the start time (field 22). */
const statLine = (pid, ppid, pgid, start, comm = 'node') => `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0`;

test('proc: parseStat reads pid, ppid, pgid and the start time, counted from the last paren of comm', () => {
  assert.deepEqual(parseStat(STAT), { pid: 4321, ppid: 1, pgid: 4321, startTime: 98765 });
  assert.deepEqual(parseStat(statLine(7, 6, 5, 44, 'a) (b')), { pid: 7, ppid: 6, pgid: 5, startTime: 44 });
  assert.equal(parseStat('7 (x) S 6'), null);
});

test('proc: listProcesses reads /proc on Linux, skipping what isn’t a PID or exits midway, and ps on macOS', () => {
  const files = { '/proc/10/stat': statLine(10, 1, 10, 500), '/proc/11/stat': statLine(11, 10, 11, 501) };
  const readFile = (p) => {
    if (!Object.hasOwn(files, p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[p];
  };
  assert.deepEqual(listProcesses({ platform: 'linux', readdir: () => ['10', 'self', '11', '12'], readFile }), [
    { pid: 10, ppid: 1, pgid: 10, startTime: 500 },
    { pid: 11, ppid: 10, pgid: 11, startTime: 501 },
  ]);
  assert.equal(
    listProcesses({
      platform: 'linux',
      readdir: () => {
        throw new Error('EACCES');
      },
    }),
    null,
  );
  // As `ps -A -o pid=,ppid=,pgid=,lstart=` prints on macOS, padded, with a trailing space.
  const ps = '    1     0     1 Fri Oct  2 08:09:08 2026    \n  176     1   176 Thu Oct 22 19:03:31 2026\n';
  const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args]);
    return ps;
  };
  assert.deepEqual(listProcesses({ platform: 'darwin', run }), [
    { pid: 1, ppid: 0, pgid: 1, startTime: Date.UTC(2026, 9, 2, 8, 9, 8) / 1000 },
    { pid: 176, ppid: 1, pgid: 176, startTime: Date.UTC(2026, 9, 22, 19, 3, 31) / 1000 },
  ]);
  assert.deepEqual(calls, [['/bin/ps', '-A', '-o', 'pid=,ppid=,pgid=,lstart=']]);
  assert.deepEqual(parsePs('garbage\n'), []);
});

// The turn’s group is 100 (the runner, and the CLI it started). The CLI starts two tool shells, each in a session of its
// own (200, 300); 200’s shell has a child in its group (201), which starts a process in a session of its own (400).
// 500 is someone else’s group, started by a process outside the turn.
const PROCS = [
  { pid: 100, ppid: 1, pgid: 100, startTime: 10 },
  { pid: 101, ppid: 100, pgid: 100, startTime: 11 },
  { pid: 200, ppid: 101, pgid: 200, startTime: 20 },
  { pid: 201, ppid: 200, pgid: 200, startTime: 21 },
  { pid: 300, ppid: 101, pgid: 300, startTime: 30 },
  { pid: 400, ppid: 201, pgid: 400, startTime: 40 },
  { pid: 500, ppid: 1, pgid: 500, startTime: 50 },
  { pid: 501, ppid: 500, pgid: 501, startTime: 51 },
];

test('proc: toolGroups finds every group led by a child of the turn’s group, transitively, with its members', () => {
  const groups = toolGroups(100, { list: () => PROCS });
  assert.deepEqual(groups?.map((g) => g.pgid).sort(), [200, 300, 400], 'not the turn’s own group, and not a group started from outside it');
  assert.deepEqual(groups?.find((g) => g.pgid === 200)?.members, [
    { pid: 200, startTime: 20 },
    { pid: 201, startTime: 21 },
  ]);
  assert.deepEqual(toolGroups(100, { list: () => PROCS.slice(0, 2) }), [], 'a turn with no tool shells');
  assert.equal(toolGroups(100, { list: () => null }), null, 'the processes couldn’t be listed');
});

test('proc: liveGroups keeps a group only while a recorded member is the same process, still in it', () => {
  const groups = /** @type {any[]} */ (toolGroups(100, { list: () => PROCS }));
  // Later: the CLI is gone and its shells have ppid 1. 200’s leader exited, but 201 is still in its group; 300’s PID
  // is now another process, which leads a group of its own; 400 is gone.
  const later = [
    { pid: 201, ppid: 1, pgid: 200, startTime: 21 },
    { pid: 300, ppid: 1, pgid: 300, startTime: 99 },
  ];
  assert.deepEqual(
    liveGroups(groups, { list: () => later }).map((g) => g.pgid),
    [200],
  );
  assert.deepEqual(liveGroups(groups, { list: () => [{ pid: 201, ppid: 1, pgid: 201, startTime: 21 }] }), [], 'a member that left the group');
  assert.deepEqual(liveGroups(groups, { list: () => null }), [], 'nothing is signaled when the processes can’t be listed');
  assert.deepEqual(
    liveGroups([], {
      list: () => {
        throw new Error('not listed for no groups');
      },
    }),
    [],
  );
});
