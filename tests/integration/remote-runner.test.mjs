// The turn runner on a remote host (#120, H1), for real: server/remote/host/runner.mjs runs a stand-in harness
// (tests/fixtures/remote/harness.mjs), with real files and a real Unix socket in a temp POSTBOX_REMOTE_HOME
// (tests/integration/host.mjs). Each test removes its home folder after. launchRunner’s choice of a systemd scope and
// proc.mjs’s parsing are unit tests, with injected facts, in tests/remote-runner.test.mjs.
//
// Starting a turn, for real (the runner’s refusals, a stale socket, a missing harness, a parent that exits at once,
// and the host’s own facts) is tests/integration/remote-runner-start.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostVersion } from '../../server/remote/host/paths.mjs';
import { sameProcess } from '../../server/remote/host/proc.mjs';
import { askRunner, sendStdin } from '../../server/remote/host/runner.mjs';
import { validateExitRecord, validateRunnerRecord } from '../../shared/remote-protocol.mjs';
import { folder, HARNESS, makeHost, mode, NO_UNIX, read, startRunner, TOKEN, TURN, until, writeTurn } from './host.mjs';

const json = (f) => JSON.parse(f.text);

// ── Steps: each runs the runner and returns what it found ──

/** A turn with a `file` stdin that prints, reads its message, and exits 3. */
async function fileTurn() {
  const h = makeHost();
  try {
    const dir = writeTurn(
      h,
      { stdin: 'file', env: { PB_SEEN: 'yes' }, argv: [HARNESS, 'out:hello', 'err:oops', 'env:PB_SEEN', 'env:POSTBOX_REMOTE_HOME', 'cwd', 'stdin', 'exit:3'] },
      { message: '{"m":1}\n' },
    );
    const r = startRunner(h);
    const runner = await r.done;
    return { runner, pid: r.pid, home: h.home, work: h.work, version: hostVersion(), ...folder(dir) };
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
}

/** A `none` stdin: the harness reads end of file at once. */
async function noneTurn() {
  const h = makeHost();
  try {
    const dir = writeTurn(h, { stdin: 'none', argv: [HARNESS, 'stdin', 'out:eof'] });
    const runner = await startRunner(h).done;
    return { runner, ...folder(dir) };
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
}

/** A held stdin: two lines through the socket, who/iam checks, then SIGTERM to the runner closes the pipe. */
async function heldTurn() {
  const h = makeHost();
  try {
    const dir = writeTurn(h, { harness: 'codex', stdin: 'held', argv: [HARNESS, 'out:ready', 'stdin', 'out:closed'] });
    const sock = join(dir, 'sock');
    const r = startRunner(h);
    await until(() => askRunner(sock, TURN, { token: TOKEN }), 'the runner’s socket');
    const sockMode = mode(sock);
    const asks = {
      right: await askRunner(sock, TURN, { token: TOKEN }),
      otherTurn: await askRunner(sock, 'other', { token: TOKEN }),
      badToken: await askRunner(sock, TURN, { token: 'x'.repeat(40) }),
      noSocket: await askRunner(join(dir, 'nope'), TURN, { token: TOKEN }),
    };
    const upTo = [await sendStdin(sock, '{"id":1}', { token: TOKEN }), await sendStdin(sock, 'two', { token: TOKEN })];
    const badStdin = await sendStdin(sock, 'x', { token: 'y'.repeat(40) }).catch((e) => e.code);
    await until(() => read(join(dir, 'out.jsonl'))?.includes('got:two'), 'the second line in out.jsonl');
    process.kill(r.pid, 'SIGTERM'); // the runner only: it stays up and closes the pipe
    const runner = await r.done;
    return { runner, sockMode, asks, upTo, badStdin, ...folder(dir) };
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
}

/** A `none` turn’s socket refuses stdin. */
async function notHeld() {
  const h = makeHost();
  try {
    const dir = writeTurn(h, { argv: [HARNESS, 'sleep:5000'] });
    const sock = join(dir, 'sock');
    const r = startRunner(h);
    await until(() => askRunner(sock, TURN, { token: TOKEN }), 'the runner’s socket');
    const code = await sendStdin(sock, 'x', { token: TOKEN }).catch((e) => e.code);
    process.kill(-r.pid, 'SIGKILL');
    await r.done;
    return { code };
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
}

/** Stop as the daemon does it: SIGINT to the runner’s process group, which the harness dies of. */
async function signalTurn() {
  const h = makeHost();
  try {
    const dir = writeTurn(h, { argv: [HARNESS, 'out:ready', 'sleep:30000'] });
    const r = startRunner(h);
    await until(() => askRunner(join(dir, 'sock'), TURN, { token: TOKEN }), 'the runner’s socket');
    await until(() => read(join(dir, 'out.jsonl')) === 'ready\n', 'the harness to start');
    const record = JSON.parse(readFileSync(join(dir, 'runner.json'), 'utf8'));
    const alive = sameProcess(record);
    process.kill(-r.pid, 'SIGINT');
    const runner = await r.done;
    return { runner, alive, aliveAfter: sameProcess(record), ...folder(dir) };
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
}

// ── Tests ──

test('runner: a file stdin turn writes out.jsonl, err.log, runner.json and exit.json, all 0600 in a 0700 folder', { skip: NO_UNIX }, async () => {
  const r = await fileTurn();
  assert.deepEqual(r.runner, { code: 0, signal: null }, 'the runner itself exits 0 once it has recorded the end');
  assert.equal(r.dirMode, 0o700);
  const out = r.files['out.jsonl'].text.split('\n');
  assert.equal(out[0], 'hello');
  assert.equal(out[1], 'PB_SEEN=yes', 'start.json’s env reaches the harness');
  assert.equal(out[2], `POSTBOX_REMOTE_HOME=${r.home}`, 'merged over the runner’s own');
  assert.match(out[3], new RegExp(`${r.work.replace(/^\/tmp/, '')}$`), 'the harness runs in start.json’s folder');
  assert.equal(out[4], 'got:{"m":1}', 'stdin is message.jsonl');
  assert.equal(r.files['err.log'].text, 'oops\n');
  const exit = json(r.files['exit.json']);
  assert.ok(validateExitRecord(exit).ok);
  assert.equal(exit.code, 3);
  assert.equal(exit.signal, null);
  const runner = json(r.files['runner.json']);
  assert.ok(validateRunnerRecord(runner).ok, 'runner.json is what the daemon validates');
  assert.equal(runner.pid, r.pid);
  assert.equal(runner.turn, 't1');
  assert.equal(runner.version, r.version);
  for (const f of ['out.jsonl', 'err.log', 'exit.json', 'runner.json']) assert.equal(r.files[f].mode, 0o600, f);
  assert.equal(r.files['in.jsonl'].text, null, 'only a held stdin has in.jsonl');
  assert.equal(r.sock, false, 'the socket is gone once the turn ends');
});

test('runner: a none stdin gives the harness end of file at once', { skip: NO_UNIX }, async () => {
  const r = await noneTurn();
  assert.equal(r.files['out.jsonl'].text, 'eof\n');
  assert.equal(json(r.files['exit.json']).code, 0);
});

test('runner: a held stdin takes lines over the socket, logs each to in.jsonl first, and closes on SIGTERM', { skip: NO_UNIX }, async () => {
  const r = await heldTurn();
  assert.equal(r.sockMode, 0o600);
  assert.deepEqual(r.asks, { right: true, otherTurn: false, badToken: false, noSocket: false }, 'who answers iam with its turn, and only to the token');
  assert.deepEqual(r.upTo, [9, 13], 'written carries in.jsonl’s size after each line');
  assert.equal(r.badStdin, 'bad-token');
  assert.equal(r.files['in.jsonl'].text, '{"id":1}\ntwo\n');
  assert.equal(r.files['in.jsonl'].mode, 0o600);
  assert.equal(r.files['out.jsonl'].text, 'ready\ngot:{"id":1}\ngot:two\nclosed\n', 'SIGTERM to the runner closed the pipe, and the harness saw end of file');
  assert.deepEqual(r.runner, { code: 0, signal: null }, 'the runner ignored SIGTERM and recorded the end');
  assert.equal(json(r.files['exit.json']).code, 0);
});

test('runner: a stdin line for a turn whose stdin isn’t held is refused as not-held', { skip: NO_UNIX }, async () => {
  assert.deepEqual(await notHeld(), { code: 'not-held' });
});

test('runner: SIGINT to the runner’s group ends the harness, and exit.json records the signal', { skip: NO_UNIX }, async () => {
  const r = await signalTurn();
  assert.equal(r.alive, true, 'sameProcess matches runner.json while the runner runs');
  assert.deepEqual(r.runner, { code: 0, signal: null }, 'the runner outlived the harness');
  const exit = json(r.files['exit.json']);
  assert.equal(exit.code, null);
  assert.equal(exit.signal, 'SIGINT');
  assert.equal(r.aliveAfter, false, 'and not once it has gone');
  assert.equal(r.sock, false);
});
