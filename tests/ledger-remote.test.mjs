// The work ledger for a turn on a remote host (#120, the plan’s L7): it records what the stream says (commands,
// branches, commits, pushes, effort, and which files the agent edited) and never reads, diffs or restores a file,
// runs git, or reads a command’s output file, since all of those are on the host and the same path here names
// something else, maybe one of the person’s own files.
//
// The streams are the recorded local Claude Code turns in tests/fixtures/claude-code (claude 2.1.309), replayed as
// if they came from a host: a remote turn’s stream is the same stream-json, carried by the daemon (architecture.md,
// “The adapters stay; only the process moves”). No recorded remote stream has edits in it yet.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { Ledger } from '../server/ledger.mjs';
import { Store } from '../server/store.mjs';
import { summarize, turnLine } from '../shared/work.mjs';

const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** File access that fails the test on any call: a remote turn must never touch the laptop’s files. */
function noFiles() {
  const calls = [];
  const no =
    (name) =>
    (...args) => {
      calls.push(`${name} ${args[0]}`);
      throw new Error(`The ledger touched a laptop file for a remote turn: ${name} ${args[0]}`);
    };
  return { calls, readNow: no('readNow'), read: no('read'), readTail: no('readTail'), writeAtomic: no('writeAtomic'), remove: no('remove') };
}
/** git that records every call and answers as a repository would, so a call can’t hide behind a failure. */
function spyGit() {
  const calls = [];
  const git = async (cwd, args) => {
    calls.push(`${cwd} $ git ${args.join(' ')}`);
    return { code: 0, stdout: `${'a'.repeat(40)}\x1fFrom the laptop’s git\n\n9\t9\twrong.txt\n`, stderr: '' };
  };
  return Object.assign(git, { calls });
}

const HOST = { id: 'ho_1', name: 'host.example.com' };

/**
 * A store with a project, a host, a persona that runs there and its session, as the runtime leaves them when a
 * remote turn starts (se.remoteTurn names the host turn and its folder on the host).
 */
function remoteStore({ personaRemote = true, remoteTurnFor = 'turn_1' } = {}) {
  const store = new Store(null);
  store.emit('host', { ...HOST, settings: {} });
  store.emit('project', { id: 'p1', name: 'P', folder: '/Users/me/proj' });
  store.emit('persona', { id: 'pe_1', handle: 'dev', backend: 'claude-code', ...(personaRemote ? { remote: { hostId: HOST.id } } : {}) });
  store.emit('thread', { id: 'th_1', kind: 'thread', projectId: 'p1', members: [] });
  store.emit('session', {
    id: 'se_1',
    handle: 'dev',
    personaId: 'pe_1',
    threadId: 'th_1',
    ...(remoteTurnFor ? { remoteTurn: { hostId: HOST.id, turn: 'host-turn-1', rtTurn: remoteTurnFor, folder: '/workspace/rec', state: 'running' } } : {}),
  });
  return store;
}

/** Replays a recorded turn into a ledger as a turn on HOST. */
async function replayRemote(name, { store = remoteStore(), turnRemote = true } = {}) {
  const io = noFiles();
  const git = spyGit();
  let t = 0;
  const ledger = new Ledger({ store, io, git, home: '/Users/me', now: () => (t += 100) });
  const turn = { id: 'turn_1', threadId: 'th_1', startedAt: 0, ...(turnRemote ? { remote: { hostId: HOST.id } } : {}) };
  // The runtime passes no folder for a remote turn, and the project’s folder on this computer.
  ledger.startTurn(turn, { se: store.state.sessions.se_1, folder: null, projectFolder: '/Users/me/proj' });
  const ctx = {
    text() {},
    activity() {},
    status() {},
    compaction() {},
    toolUse: (u) => ledger.toolUse(turn, u),
    toolResult: (r) => ledger.toolResult(turn, r),
    taskEnded: (x) => ledger.taskEnded(turn, x),
    usage: (u) => ledger.usage(turn, u),
  };
  const m = createStreamMapper(ctx, { now: () => 1000 });
  for (const e of fixture(name)) m.push(e);
  await ledger.endTurn(turn, { status: 'done' });
  await ledger.idle();
  const entries = store.state.work.th_1;
  const of = (kind) => entries.filter((e) => e.kind === kind);
  return { store, ledger, io, git, entries, of, turn };
}

test('a remote turn’s edits are steps on its host: no laptop file is read, no git runs, and no file or diff is recorded', async () => {
  const { of, io, git, entries } = await replayRemote('ledger-edits');
  assert.deepEqual(io.calls, [], 'no laptop file was read or written');
  assert.deepEqual(git.calls, [], 'no git ran on the laptop');
  assert.deepEqual([of('file').length, of('change').length], [0, 0], 'nothing to diff or restore');
  assert.deepEqual(
    of('edit').map((e) => [e.rel, e.tools, e.host.name, e.outside]),
    [
      ['notes.txt', 1, 'host.example.com', false],
      ['hello.md', 1, 'host.example.com', false],
      ['untracked.txt', 1, 'host.example.com', false],
    ],
    'each file the agent edited, relative to its folder on the host',
  );
  assert.ok(
    entries.every((e) => e.kind === 'edit' || !('before' in e)),
    'no copy of a file from before',
  );
});

test('a remote turn’s commands, commit and effort still record from the stream, without the output file', async () => {
  const { of, ledger } = await replayRemote('ledger-edits');
  const cmds = of('command');
  assert.deepEqual(
    cmds.map((c) => [c.command.split(" -m 'Co")[0], c.state, c.exit, c.host?.name]),
    [
      ['ls nope-missing', 'failed', 2, 'host.example.com'],
      ['sleep 2; echo bg-done', 'done', 0, 'host.example.com'],
      ["git add -A && git commit -m 'Ledger test'", 'done', 0, 'host.example.com'],
    ],
  );
  assert.match(await ledger.output('th_1', cmds[0].id), /No such file or directory/, 'output from the stream is kept');
  assert.equal(cmds[1].endedInBackground, true, 'the task notification still ends it');
  assert.equal(await ledger.output('th_1', cmds[1].id), '', 'the output file is on the host, so it isn’t read');
  const [commit] = of('commit');
  assert.deepEqual([commit.sha, commit.branch, commit.cwd, commit.message], ['0e1af64', 'master', '/workspace/rec', 'Ledger test'], 'as the stream said');
  assert.deepEqual([commit.files, commit.added, commit.deleted], [[], 0, 0], 'git here isn’t asked about the host’s repository');
  const [turn] = of('turn');
  assert.deepEqual(turn.host, HOST);
  assert.equal(turn.toolCalls, 9);
  assert.equal(turn.costUsd, 0.0059722, 'the last running total, to 12 places as the store keeps costs (#525)');
  assert.equal(turn.tokens.cacheRead, 235850);
});

test('a remote turn’s branch, push and subagent edit record; an edit made twice is one step', async () => {
  const { of, io, git } = await replayRemote('ledger-push');
  assert.deepEqual([io.calls, git.calls], [[], []]);
  assert.deepEqual(
    of('edit').map((e) => [e.rel, e.tools, e.who]),
    [
      ['notes.txt', 2, null],
      ['hello.md', 1, null],
      ['sub.txt', 1, 'general-purpose'],
    ],
  );
  assert.deepEqual(
    of('branch').map((b) => b.name),
    ['feature'],
  );
  const [push] = of('push');
  assert.deepEqual([push.branch, push.remote, push.refs, push.host.name], ['feature', '/workspace/remote.git', ['feature → feature'], 'host.example.com']);
  assert.equal(of('commit')[0].message, 'Second');
});

test('git state, diffs and Restore never reach the laptop for a host’s work', async () => {
  const { ledger, of, io, git, entries } = await replayRemote('ledger-edits');
  const g = await ledger.gitState('th_1');
  assert.deepEqual(git.calls, [], 'no git ran');
  assert.deepEqual(g.files, {});
  assert.deepEqual(g.repos, []);
  assert.equal(g.commits[of('commit')[0].id].pushed, null, 'git here can’t say, so it doesn’t guess');
  const edit = of('edit')[0];
  for (const call of [() => ledger.restore('th_1', edit.id), () => ledger.fileDiff('th_1', edit.id)])
    await assert.rejects(call, (e) => e.status === 409 && /notes\.txt is on host\.example\.com/.test(e.message) && /can’t restore it/.test(e.message));
  assert.deepEqual(io.calls, [], 'nothing was read or written');
  assert.ok(!entries.some((e) => e.kind === 'restore'));
  // The totals count no files for it, the turn isn’t called idle, and its line says where its files are.
  const s = summarize(entries);
  assert.deepEqual([s.total.files, s.files.length, s.edits.length, s.idle.turns], [0, 0, 3, 0]);
  assert.equal(turnLine(entries, 'turn_1'), '3 files edited on host.example.com · 3 commands (1 failed) · 1 commit · 3 s in all · <$0.01');
});

test('a turn is remote by its persona or its session’s host turn, and only then', async () => {
  // The persona runs on the host, though the runtime didn’t mark the turn (an older caller).
  const byPersona = await replayRemote('ledger-push', { turnRemote: false, store: remoteStore({ remoteTurnFor: null }) });
  assert.deepEqual([byPersona.io.calls, byPersona.of('edit').length, byPersona.of('file').length], [[], 3, 0]);
  // The session’s host turn is this turn (attached again after a restart), whatever the persona says now.
  const bySession = await replayRemote('ledger-push', { turnRemote: false, store: remoteStore({ personaRemote: false }) });
  assert.deepEqual([bySession.io.calls, bySession.of('edit').length], [[], 3]);
  // A session that ran on a host before, whose persona runs here now, is local again: its files are read here.
  const store = remoteStore({ personaRemote: false, remoteTurnFor: 'turn_0' });
  const ledger = new Ledger({ store, io: noFiles(), git: spyGit() });
  assert.equal(ledger.hostOf({ id: 'turn_1' }, store.state.sessions.se_1), null);
  assert.deepEqual(ledger.hostOf({ id: 'turn_1', remote: { hostId: HOST.id } }, store.state.sessions.se_1), HOST);
});
