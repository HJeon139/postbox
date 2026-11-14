// Work’s interface (designs/architecture/services.md, “Ledger and work”): the work ledger’s answers to the page, a
// turn’s work recorded as it runs and when it ends, the archive passes (#305), and the person’s `!` commands (#67).
// Built on an in-memory store, the real Threads and Running, a small fake of the ledger, and fakes of Sessions,
// Personas and Placement; it never builds Runtime.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';
import { Threads } from '../server/threads.mjs';
import { seenCall } from '../server/turn-work.mjs';
import { Work } from '../server/work-service.mjs';

/** A ledger that records each call by name, and answers with what the test gives it. */
function fakeLedger() {
  const calls = [];
  /** Notes a call, then gives its answer. @param {unknown[]} call @param {any} [answer] */
  const noted = (call, answer) => {
    calls.push(call);
    return answer;
  };
  const ledger = {
    calls,
    blobs: null,
    /** @type {any} */ restored: { rel: 'a.txt', handles: ['alpha'], before: { exists: true } },
    /** @type {any} */ failWith: null,
    /** @type {any[]} */ entries: () => [{ kind: 'change', turnId: 'tu_1', fileId: 'f1', handle: 'alpha', added: 2, deleted: 1 }],
    gitState: (convId) => noted(['gitState', convId], { convId }),
    fileDiff: async (convId, fileId, changeId) => {
      calls.push(['fileDiff', convId, fileId, changeId]);
      if (ledger.failWith) throw ledger.failWith;
      return { convId };
    },
    output: async (convId, entryId) => {
      calls.push(['output', convId, entryId]);
      if (ledger.failWith) throw ledger.failWith;
      return { convId };
    },
    restore: async (convId, fileId) => noted(['restore', convId, fileId], ledger.restored),
    endTurn: (turn, opts) => noted(['endTurn', turn.id, opts.status], ledger.failWith ? Promise.reject(ledger.failWith) : Promise.resolve(null)),
    toolUse: (_turn, u) => calls.push(['toolUse', u.id]),
    toolResult: (_turn, r) => calls.push(['toolResult', r.id]),
    taskEnded: (_turn, t) => calls.push(['taskEnded', t.toolUseId]),
    usage: (_turn, u) => calls.push(['usage', u.costUsd]),
    expireStale: () => calls.push(['expireStale']),
    idle: () => noted(['idle'], Promise.resolve()),
  };
  return ledger;
}

/** A fake spawn: each call makes a child the test drives, and records how it was started. */
function fakeSpawn() {
  const children = [];
  const spawn = (cmd, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), cmd, args, opts, signals: [] });
    child.kill = (sig) => {
      child.signals.push(sig);
      if (sig === 'SIGINT') queueMicrotask(() => child.emit('close', null, 'SIGINT'));
      return true;
    };
    child.exit = (code) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
}

const tick = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Work over a store with a project, a conversation with one agent, and a topic thread in it. `host` puts the agent on
 * a host; `writable` is what the injected whenWritable sees.
 */
function rig({ host = false, archiveTurns = false } = {}) {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: '/work/project' });
  store.emit('thread', {
    id: 'th_c',
    projectId: 'p1',
    title: 'C',
    kind: 'thread',
    parentId: null,
    members: ['se_1'],
    lastSpeaker: 'se_1',
    queue: [],
    createdAt: 1,
  });
  store.emit('thread', { id: 'th_t', projectId: 'p1', title: 'T', kind: 'topic', parentId: 'th_c', members: [], queue: [], createdAt: 2 });
  store.emit('session', { id: 'se_1', personaId: 'pe_a', threadId: 'th_c', handle: 'alpha', backend: 'mock' });
  const threads = new Threads({ store, bus: new Bus() });
  const running = new Running();
  const ledger = fakeLedger();
  const persona = { id: 'pe_a', handle: 'alpha', backend: 'mock', folder: '/work/alpha', ...(host ? { remote: { hostId: 'h1' } } : {}) };
  const sessions = { in: (/** @type {string} */ id) => Object.values(store.state.sessions).filter((se) => se.threadId === id) };
  const personas = { forSession: () => persona };
  const placement = {
    requestAdapter: () => ({ name: 'mock', folderFor: async (p, project) => p.folder || project?.folder }),
    hereFolder: async (_p, project) => ({ folder: project?.folder ?? null, host: 'far' }),
  };
  /** @type {(() => void)[]} */
  const waiting = [];
  const gate = { writable: true };
  const whenWritable = (/** @type {() => void} */ fn) => (gate.writable ? fn() : waiting.push(fn));
  const { spawn, children } = fakeSpawn();
  const work = new Work({ store, threads, sessions, personas, placement, running, ledger, spawnShell: spawn, whenWritable, archiveTurns });
  return { store, threads, running, ledger, work, children, gate, waiting };
}

const items = (store, threadId) => store.items(threadId);

// ── The work view’s answers (#132) ───────────────────────────────────────────────────

test('workGit answers for the conversation, and a topic thread is sent to its conversation with a 404', () => {
  const { work, ledger } = rig();
  assert.deepEqual(work.workGit('th_c'), { convId: 'th_c' });
  assert.throws(
    () => work.workGit('th_t'),
    (e) => e.status === 404 && /conversation this thread belongs to/.test(e.message),
  );
  assert.throws(
    () => work.workGit('th_gone'),
    (e) => e.status === 404,
  );
  assert.deepEqual(ledger.calls, [['gitState', 'th_c']]);
});

test('workDiff and workOutput answer a ledger error with its status as an HTTP error, and pass any other error on', async () => {
  const { work, ledger } = rig();
  assert.deepEqual(await work.workDiff('th_c', 'f1', 'c1'), { convId: 'th_c' });
  ledger.failWith = Object.assign(new Error('That file isn’t in this conversation’s work.'), { status: 404 });
  await assert.rejects(
    () => work.workDiff('th_c', 'f9'),
    (e) => e.status === 404 && /isn’t in this conversation’s work/.test(e.message),
  );
  await assert.rejects(
    () => work.workOutput('th_c', 'k9'),
    (e) => e.status === 404,
  );
  ledger.failWith = new Error('disk');
  await assert.rejects(
    () => work.workOutput('th_c', 'k1'),
    (e) => e.status === undefined && e.message === 'disk',
  );
});

test('restoreWork puts the file back and says so in the conversation, naming the agents; a file they created is removed', async () => {
  const { work, ledger, store } = rig();
  await work.restoreWork('th_c', 'f1');
  assert.equal(items(store, 'th_c').at(-1).text, 'Restored a.txt to how it was before @alpha changed it');
  ledger.restored = { rel: 'new.txt', handles: [], before: { exists: false } };
  await work.restoreWork('th_c', 'f2');
  assert.equal(items(store, 'th_c').at(-1).text, 'Removed new.txt, which the agents created');
  assert.equal(items(store, 'th_c').at(-1).kind, 'voice');
});

// ── A turn’s work ────────────────────────────────────────────────────────────────────

test('workEvents records a tool call’s start, result, task end and spend only while the turn is live, and sees each call', () => {
  const { work, ledger } = rig();
  let live = true;
  const turn = { id: 'tu_1' };
  const ev = work.workEvents(turn, () => live);
  ev.toolUse({ id: 'toolu_1', name: 'Bash', input: { command: 'ls' } });
  ev.toolResult({ id: 'toolu_1' });
  ev.taskEnded({ toolUseId: 'toolu_1' });
  ev.usage({ costUsd: 0.01 });
  assert.equal(seenCall(turn, 'toolu_1')?.state, 'answered', 'the call was seen, then answered');
  live = false;
  ev.toolUse({ id: 'toolu_2', name: 'Bash', input: {} });
  ev.toolResult({ id: 'toolu_2' });
  ev.usage({ costUsd: 0.02 });
  assert.deepEqual(ledger.calls, [
    ['toolUse', 'toolu_1'],
    ['toolResult', 'toolu_1'],
    ['taskEnded', 'toolu_1'],
    ['usage', 0.01],
  ]);
  assert.equal(seenCall(turn, 'toolu_2'), null, 'a call after the turn ended isn’t seen');
});

test('endWork records the turn’s end at once, then gives its last reply the list that leads to it (#195)', async () => {
  const { work, ledger, store, threads } = rig();
  const reply = threads.addItem('th_c', { kind: 'agent', turnId: 'tu_1', text: 'done' });
  threads.addItem('th_c', { kind: 'agent', turnId: 'tu_0', text: 'older' });
  const turn = { id: 'tu_1', threadId: 'th_c', sessionId: 'se_1', work: { convId: 'th_c', se: { handle: 'alpha' } } };
  const ended = work.endWork(turn, 'failed');
  assert.deepEqual(ledger.calls, [['endTurn', 'tu_1', 'failed']], 'the ledger hears the end before endWork returns');
  assert.equal(store.item('th_c', reply.id).work, undefined, 'the list waits for the ledger');
  await ended;
  const it = store.item('th_c', reply.id);
  assert.equal(it.workTurn, 'tu_1');
  assert.ok(it.work, 'the reply carries the turn’s line');
});

test('endWork logs a ledger that fails, naming the agent, and still resolves', async () => {
  const { work, ledger } = rig();
  ledger.failWith = new Error('disk full');
  const warned = [];
  const error = console.error;
  console.error = (...a) => warned.push(a.join(' '));
  try {
    await work.endWork({ id: 'tu_1', threadId: 'th_c', sessionId: 'se_1', work: { convId: 'th_c', se: { handle: 'alpha' } } }, 'done');
  } finally {
    console.error = error;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /@alpha.*wasn’t recorded.*disk full/);
});

test('the archive passes are off unless asked for, and count a live turn and a kept job as running (#305)', async () => {
  const off = rig();
  assert.equal(await off.work.archive.conversation('th_c'), 0);
  const { work, running, store } = rig({ archiveTurns: true });
  running.begin({ id: 'tu_live', sessionId: 'se_1' });
  store.emit('session', { ...store.state.sessions.se_1, jobs: [{ kept: true, turnId: 'tu_kept' }] });
  assert.deepEqual([...work.archive.running()].sort(), ['tu_kept', 'tu_live']);
  await work.stopArchive(10);
  assert.equal(await work.archive.conversation('th_c'), 0, 'no pass starts once stopped');
});

// ── `!` commands (#67) ───────────────────────────────────────────────────────────────

test('commandFolder is where the last speaker works, and the project’s folder here for an agent on a host', async () => {
  assert.deepEqual(await rig().work.commandFolder('th_c'), { folder: '/work/alpha', host: null });
  assert.deepEqual(await rig({ host: true }).work.commandFolder('th_c'), { folder: '/work/project', host: 'far' });
});

test('runShellCommand runs in that folder, streams its output into a command item, and ends it with its exit code', async () => {
  const { work, store, children } = rig();
  await assert.rejects(
    () => work.runShellCommand('th_c', '  '),
    (e) => e.status === 422,
  );
  const { item } = await work.runShellCommand('th_c', ' npm test ');
  const c = children[0];
  assert.deepEqual([c.args, c.opts.cwd], [['-c', 'npm test'], '/work/alpha']);
  c.stdout.write('ok\n');
  await tick();
  work.flushShellOutput();
  assert.equal(store.item('th_c', item.id).text, 'ok\n');
  c.exit(0);
  await tick();
  const done = store.item('th_c', item.id);
  assert.deepEqual([done.status, done.exitCode], ['done', 0]);
  assert.equal(work.shellRuns.size, 0);
  assert.throws(
    () => work.stopShellCommand('th_c', item.id),
    (e) => e.status === 409,
  );
});

test('a command’s end waits for the store to be writable before it is written', async () => {
  const { work, store, children, gate, waiting } = rig();
  const { item } = await work.runShellCommand('th_c', 'true');
  gate.writable = false;
  children[0].exit(0);
  await tick();
  assert.equal(store.item('th_c', item.id).status, 'running');
  for (const fn of waiting.splice(0)) fn();
  assert.equal(store.item('th_c', item.id).status, 'done');
});

test('stopShellCommand stops a running command, and stopAll stops every one as Postbox shuts down', async () => {
  const { work, store, children } = rig();
  const a = await work.runShellCommand('th_c', 'sleep 1');
  await work.runShellCommand('th_c', 'sleep 2');
  assert.deepEqual(work.stopShellCommand('th_c', a.item.id), { ok: true });
  await tick();
  assert.equal(store.item('th_c', a.item.id).status, 'stopped');
  await work.stopAll({ graceMs: 10 });
  await tick();
  assert.deepEqual(children[1].signals, ['SIGINT', 'SIGKILL']);
  assert.match(store.items('th_c').at(-1).error, /shut down/);
});

test('expireStale ends a command left running by a restart, then the ledger’s stale records; idle waits for the ledger', async () => {
  const { work, store, ledger, threads } = rig();
  const it = threads.addItem('th_c', { kind: 'command', command: 'x', status: 'running' });
  work.expireStale();
  assert.equal(store.item('th_c', it.id).status, 'stopped');
  assert.deepEqual(ledger.calls, [['expireStale']]);
  await work.idle();
  assert.deepEqual(ledger.calls.at(-1), ['idle']);
});
