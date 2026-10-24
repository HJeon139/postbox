// The turn runner on a remote host (#120, H1), for real, as it starts: server/remote/host/runner.mjs runs a stand-in
// harness (tests/fixtures/remote/harness.mjs) in a temp POSTBOX_REMOTE_HOME (tests/integration/host.mjs), and refuses
// a turn it can’t start, replaces a stale socket, ends a turn whose harness isn’t there, and outlives the parent that
// launched it; the host’s own facts are read for real. Each test removes its home folder after. The turns themselves
// are tests/integration/remote-runner.test.mjs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { bootId, sameProcess, startTime } from '../../server/remote/host/proc.mjs';
import { logindFacts } from '../../server/remote/host/runner.mjs';
import { folder, HARNESS, makeHost, NO_UNIX, startRunner, TURN, until, writeTurn } from './host.mjs';

const NO_LOGIND = process.platform !== 'linux' && 'needs systemd’s logind, which only Linux has';
const json = (f) => JSON.parse(f.text);

/** A stale socket from a runner that was killed is removed and listened on again. */
async function staleSocket() {
  const h = makeHost();
  try {
    const dir = writeTurn(h, { argv: [HARNESS, 'out:ok'] });
    const sock = join(dir, 'sock');
    const killed = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, 'SIGKILL'))`,
    ]);
    await new Promise((r) => killed.on('exit', r));
    const staleBefore = lstatSync(sock).isSocket();
    const runner = await startRunner(h).done;
    return { staleBefore, runner, ...folder(dir) };
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
}

/** Turns the runner won’t start, each with its err.log line and no runner.json. */
async function refusals() {
  const out = {};
  const cases = {
    badStdin: (h) => writeTurn(h, { stdin: 'pipe' }),
    otherTurn: (h) => {
      const dir = writeTurn(h, {});
      writeFileSync(join(dir, 'start.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'start.json'), 'utf8')), turn: 't2' }));
      return dir;
    },
    notJson: (h) => {
      const dir = writeTurn(h, {});
      writeFileSync(join(dir, 'start.json'), '{');
      return dir;
    },
    noMessage: (h) => writeTurn(h, { stdin: 'file' }),
    noFolder: (h) => writeTurn(h, { folder: join(h.home, 'missing') }),
    alreadyRan: (h) => {
      const dir = writeTurn(h, {});
      writeFileSync(join(dir, 'runner.json'), '{}');
      return dir;
    },
    notASocket: (h) => {
      const dir = writeTurn(h, {});
      writeFileSync(join(dir, 'sock'), '');
      return dir;
    },
  };
  for (const [name, make] of Object.entries(cases)) {
    const h = makeHost();
    try {
      const dir = make(h);
      const runner = await startRunner(h).done;
      out[name] = { runner, ...folder(dir) };
    } finally {
      rmSync(h.home, { recursive: true, force: true });
    }
  }
  return out;
}

/** A program that isn’t there still ends the turn, as a shell would: 127, and why in err.log. */
async function missingProgram() {
  const h = makeHost();
  try {
    const dir = writeTurn(h, { program: join(h.home, 'no-such-harness') });
    const runner = await startRunner(h).done;
    return { runner, ...folder(dir) };
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
}

/** launchRunner from a parent that exits at once: the runner carries on and records the end. */
async function outlivesParent() {
  const h = makeHost();
  try {
    const dir = writeTurn(h, { argv: [HARNESS, 'sleep:500', 'out:after', 'exit:0'] });
    const parent = spawn(process.execPath, [join(dirname(HARNESS), 'launch-parent.mjs'), TURN], { env: h.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let printed = '';
    parent.stdout.on('data', (d) => (printed += d));
    const parentExit = await new Promise((r) => parent.on('exit', (code) => r(code)));
    const exitBefore = existsSync(join(dir, 'exit.json'));
    await until(() => existsSync(join(dir, 'exit.json')) && !existsSync(join(dir, 'sock')), 'exit.json');
    const record = JSON.parse(readFileSync(join(dir, 'runner.json'), 'utf8'));
    return { parentExit, launchedPid: Number(printed.trim()), parentPid: parent.pid, exitBefore, ...folder(dir), recordPid: record.pid };
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
}

/** This machine’s facts, read for real. */
async function facts() {
  const r = { bootId: bootId(), startTime: startTime(process.pid), gone: startTime(2 ** 31 - 1) };
  return { ...r, same: sameProcess({ pid: process.pid, bootId: r.bootId ?? '', startTime: r.startTime ?? -1 }), logind: logindFacts() };
}

test('runner: a stale socket from a killed runner is removed and listened on again', { skip: NO_UNIX }, async () => {
  const r = await staleSocket();
  assert.equal(r.staleBefore, true);
  assert.equal(r.files['out.jsonl'].text, 'ok\n');
  assert.equal(json(r.files['exit.json']).code, 0);
});

test('runner: refuses a turn it can’t start, says why in err.log, and starts nothing', { skip: NO_UNIX }, async () => {
  const r = await refusals();
  const why = {
    badStdin: /start\.json\.stdin must be one of file, none, held/,
    otherTurn: /start\.json is for turn t2, not t1/,
    notJson: /start\.json can’t be read/,
    noMessage: /message\.jsonl, isn’t there/,
    noFolder: /The work folder .* isn’t there/,
    notASocket: /sock is there and isn’t a socket/,
    alreadyRan: /This turn has already run: runner\.json is there/,
  };
  assert.deepEqual(Object.keys(r).sort(), Object.keys(why).sort());
  for (const [name, re] of Object.entries(why)) {
    assert.equal(r[name].runner.code, 1, `${name} exits non-zero`);
    assert.match(r[name].files['err.log'].text, re, name);
    assert.equal(r[name].files['err.log'].mode, 0o600, name);
    assert.equal(r[name].files['exit.json'].text, null, `${name} has no exit.json`);
    if (name !== 'alreadyRan') assert.equal(r[name].files['runner.json'].text, null, `${name} has no runner.json`);
  }
});

test('runner: a harness that isn’t there ends the turn with 127, as a shell would, and says why', { skip: NO_UNIX }, async () => {
  const r = await missingProgram();
  assert.equal(json(r.files['exit.json']).code, 127);
  assert.match(r.files['err.log'].text, /no-such-harness didn’t start: .*ENOENT/);
});

test('runner: launched by a parent that exits at once, it carries on and writes exit.json', { skip: NO_UNIX }, async () => {
  const r = await outlivesParent();
  assert.equal(r.parentExit, 0);
  assert.equal(r.exitBefore, false, 'the parent was gone before the turn ended');
  assert.notEqual(r.launchedPid, r.parentPid);
  assert.equal(r.recordPid, r.launchedPid, 'launchRunner’s pid is the runner’s, as runner.json records it');
  assert.equal(r.files['out.jsonl'].text, 'after\n');
  assert.equal(json(r.files['exit.json']).code, 0);
});

test('logindFacts: on this Linux host, each fact is true, false or null', { skip: NO_LOGIND }, async () => {
  const { logind } = await facts();
  for (const v of Object.values(logind)) assert.ok(v === true || v === false || v === null);
});

test('proc: this machine’s own process matches itself', { skip: NO_UNIX }, async () => {
  const r = await facts();
  assert.match(r.bootId, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isSafeInteger(r.startTime));
  assert.equal(r.gone, null);
  assert.equal(r.same, true);
});
