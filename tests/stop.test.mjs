// Stop (#126) and background jobs (#129): the CLI’s process group, one process per session, a stopped turn’s tool
// calls refused, and the jobs an agent leaves running. No real processes: spawn, ps and kill are fakes, fed from
// streams and ps output recorded on claude 2.1.296 (tests/fixtures/claude-code/background-*).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { AgentSdkAdapter } from '../server/adapters/agent-sdk.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { evalOf, parsePs, runsCommand, shellGroups, stopTurn } from '../server/adapters/process-group.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(fn(), `Timed out waiting for ${label}`);
};
const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const PS = parsePs(readFileSync(new URL('fixtures/claude-code/background-ps.txt', import.meta.url), 'utf8'));
const CLI = 69116;

/** Groups whose fake CLI has exited (fakeChild’s exit), as kill(-pid, 0) sees them. */
const exitedGroups = new Set();

/** A fake kill: records each signal, and says a group is gone once its fake CLI has exited (or when `gone` says so). */
function fakeKill(gone = new Set()) {
  const sent = [];
  const kill = (pid, sig) => {
    if (sig === 0) {
      if (gone.has(pid) || exitedGroups.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      return true;
    }
    sent.push([pid, sig]);
    return true;
  };
  return { kill, sent, gone };
}

/** A spawned CLI that runs until it’s signaled: SIGINT or SIGKILL to its group (or to it) ends it. */
function fakeChild({ pid = CLI, lines = [] } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: [] });
  child.kill = (sig) => child.killed.push(sig);
  child.exit = () => {
    exitedGroups.add(-pid);
    child.stdout.end();
    child.emit('exit', null, 'SIGINT');
    setImmediate(() => child.emit('close', null));
  };
  setImmediate(() => {
    for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
  });
  return child;
}

/** A turn context that records what the adapter reported. */
function fakeCtx(over = {}) {
  const abort = new AbortController();
  const calls = { text: '', activity: [], status: [], jobs: [], control: null };
  return {
    calls,
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=se_1&turn=t1',
    persona: { handle: 'developer', model: 'claude-opus-5-5', permissionMode: 'auto', folder: '/tmp/pb-test-dev' },
    project: null,
    handles: ['developer'],
    state: {},
    saveState() {},
    pathOf: () => null,
    text: (d) => {
      calls.text += d;
    },
    activity: (a) => calls.activity.push(a),
    status: (s) => calls.status.push(s),
    compaction() {},
    job: (j) => calls.jobs.push(j),
    control: (c) => {
      calls.control = c;
    },
    ...over,
  };
}

// ── The process group ─────────────────────────────────────────────────────────────

test('#126: the recorded ps finds the CLI’s tool shells, each in a group of its own, and not another CLI’s orphan', () => {
  const shells = shellGroups(PS, CLI);
  assert.deepEqual(
    shells.map((s) => s.pgid),
    [69193, 69282],
  );
  assert.ok(runsCommand(shells[0], "sleep 170; echo 'pbx C'"), 'a quote inside the command is quoted as Claude Code does');
  assert.ok(runsCommand(shells[1], 'until false; do sleep 40; done'));
  assert.ok(!runsCommand(shells[1], 'sleep 170'));
});

test('#164: runsCommand reads what the eval runs, in either quoting, give or take a leading cd and whitespace, and no looser', () => {
  const sq = (c) => ({ pid: 1, ppid: 1, pgid: 1, command: evalLine(c) });
  const bs = (c) => ({ pid: 1, ppid: 1, pgid: 1, command: `/bin/bash -c eval '${c.replaceAll("'", `'\\''`)}' < /dev/null && pwd -P` });
  for (const shell of [sq, bs]) {
    assert.ok(runsCommand(shell("echo 'a b'; ls"), "echo 'a b'; ls"), 'a quote inside, either style');
    assert.ok(runsCommand(shell('echo "\'"'), 'echo "\'"'));
    assert.ok(runsCommand(shell("'\\''"), "'\\''"), 'the other style’s quoting, as text, isn’t undone');
    assert.ok(runsCommand(shell('npm test'), 'cd /tmp/w && npm test'), 'a cd Claude Code applied itself');
    assert.ok(runsCommand(shell('npm test'), "cd '/tmp/my work' && cd sub && npm test"), 'a quoted cd path, and two');
    assert.ok(runsCommand(shell('cd /tmp/w && npm test'), 'npm test'), 'a cd left in the eval');
    assert.ok(runsCommand(shell('sleep  5;\n  echo hi'), ' sleep 5; echo hi '), 'whitespace');
    assert.ok(!runsCommand(shell('sleep 50'), 'sleep 5'));
    assert.ok(!runsCommand(shell('sleep 5'), 'sleep 50'));
    assert.ok(!runsCommand(shell('x'), 'echo hix'));
    assert.ok(!runsCommand(shell('npm test'), 'npm install && npm test'), 'a command that only ends with it is another');
    assert.ok(!runsCommand(shell('npm test'), 'cd /tmp/w'));
  }
  assert.ok(!runsCommand({ pid: 1, ppid: 1, pgid: 1, command: 'sleep 5' }, 'sleep 5'), 'not a tool shell');
  assert.ok(!runsCommand(sq(''), ''));
  assert.equal(evalOf("zsh -c eval 'a' && eval 'b'"), 'a', 'the wrapper’s eval, the first');
});

test('#126: the Claude Code CLI starts in its own group, and Stop signals the group, then every tool shell once it has exited', async () => {
  const child = fakeChild();
  const k = fakeKill();
  const spawned = [];
  const adapter = new ClaudeCodeAdapter({
    bin: 'claude',
    workRoot: '/tmp/pb-test-work',
    spawnImpl: /** @type {any} */ (
      (_bin, _args, opts) => {
        spawned.push(opts);
        return child;
      }
    ),
    kill: k.kill,
    listProcesses: async () => PS,
  });
  const ctx = fakeCtx();
  const done = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx);
  // deliver makes the agent’s folder before it spawns: wait for the spawn, not a fixed time, which a busy CI runner outlasts.
  await until(() => spawned.length, 'the spawn');
  assert.equal(spawned[0].detached, true, 'its own process group');
  ctx.abort.abort();
  await sleep(5);
  assert.deepEqual(k.sent, [[-CLI, 'SIGINT']], 'SIGINT to the whole group, not only the launcher');
  assert.deepEqual(child.killed, [], 'not child.kill(), which reaches only the process it spawned');
  child.exit();
  await done;
  assert.deepEqual(k.sent.slice(1), [
    [-69193, 'SIGKILL'],
    [-69282, 'SIGKILL'],
  ]);
});

/** A CLI’s exit, resolved by the test: (it exits, and its group is gone) */
function exitLater(k, pid = CLI) {
  let exit = () => {};
  const exited = new Promise((r) => {
    exit = () => {
      k.gone.add(-pid);
      r(undefined);
    };
  });
  return { exited, exit: () => exit() };
}

test('#126: a CLI that ignores SIGINT gets SIGKILL after the grace period, its group and its tool shells', async () => {
  const k = fakeKill();
  const { exited, exit } = exitLater(k);
  const { gone } = await stopTurn(fakeChild(), { exited, kill: k.kill, list: async () => PS, graceMs: 10, pollMs: 2 });
  assert.deepEqual(k.sent, [[-CLI, 'SIGINT']]);
  await until(() => k.sent.length > 1, 'the grace period');
  assert.deepEqual(k.sent.slice(1), [
    [-CLI, 'SIGKILL'],
    [-69193, 'SIGKILL'],
    [-69282, 'SIGKILL'],
  ]);
  exit();
  await gone;
});

test('#129: keeping a background job: the CLI gets SIGKILL at once, since its SIGINT would stop the job, and the job’s group is kept', async () => {
  const k = fakeKill();
  const a = exitLater(k);
  const { kept, gone } = await stopTurn(fakeChild(), {
    keep: [{ id: 'bm2939coh', command: "sleep 170; echo 'pbx C'" }],
    exited: a.exited,
    kill: k.kill,
    list: async () => PS,
    pollMs: 2,
  });
  const shell = PS.find((p) => p.pid === 69193);
  assert.deepEqual(kept, [{ id: 'bm2939coh', pgid: 69193, groups: [{ pgid: 69193, command: shell?.command }] }]);
  assert.deepEqual(k.sent, [
    [-CLI, 'SIGKILL'],
    [-69282, 'SIGKILL'],
  ]);
  a.exit();
  await gone;
  assert.ok(!k.sent.some(([pid]) => pid === -69193), 'the kept job is never signaled');
});

// The shell #164 recorded with ps: Claude Code applied the job’s `cd` itself, so its eval runs the loop alone.
const LOOP = "for i in $(seq 1 36); do date '+%H:%M:%S' >> heartbeat-1.log; sleep 5; done";
const LOOP_JOB = `cd /private/tmp/w-1S75EQ && ${LOOP}`;
const evalLine = (command) =>
  `/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1792726346291-5lxk5d.sh 2>/dev/null || true && eval '${command.replaceAll("'", `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-a1b2-cwd`;
/** The recorded ps, with the loop’s shell under the CLI too. */
const PS_LOOP = [...PS, { pid: 69400, ppid: CLI, pgid: 69400, command: evalLine(LOOP) }, { pid: 69401, ppid: 69400, pgid: 69400, command: 'sleep 5' }];

test('#164: a job whose cd Claude Code applied itself is kept: its shell’s eval runs the loop without the cd', async () => {
  const loop = PS_LOOP.find((p) => p.pid === 69400);
  assert.ok(loop && !loop.command.includes('cd /private'), 'as recorded: no cd in the eval');
  assert.equal(evalOf(loop.command), LOOP);
  assert.ok(runsCommand(loop, LOOP_JOB));
  const k = fakeKill();
  const a = exitLater(k);
  const { kept, gone } = await stopTurn(fakeChild(), {
    keep: [{ id: 'b8hb2', command: LOOP_JOB }],
    exited: a.exited,
    kill: k.kill,
    list: async () => PS_LOOP,
    pollMs: 2,
  });
  assert.deepEqual(kept, [{ id: 'b8hb2', pgid: 69400, groups: [{ pgid: 69400, command: loop?.command }] }]);
  assert.deepEqual(k.sent, [
    [-CLI, 'SIGKILL'],
    [-69193, 'SIGKILL'],
    [-69282, 'SIGKILL'],
  ]);
  a.exit();
  await gone;
  assert.ok(!k.sent.some(([pid]) => pid === -69400), 'the kept job is never signaled');
});

test('#164: a kept job that matches no shell isn’t killed: the CLI gets SIGKILL, and every other tool shell is kept as its groups', async () => {
  const k = fakeKill();
  const a = exitLater(k);
  const { kept, gone } = await stopTurn(fakeChild(), {
    keep: [{ id: 'x', command: 'npm run long' }],
    exited: a.exited,
    kill: k.kill,
    list: async () => PS,
    pollMs: 2,
  });
  const groups = shellGroups(PS, CLI).map((s) => ({ pgid: s.pgid, command: s.command }));
  assert.deepEqual(kept, [{ id: 'x', pgid: 69193, groups }]);
  assert.deepEqual(k.sent, [[-CLI, 'SIGKILL']], 'never SIGINT, which the CLI would pass on to its jobs');
  a.exit();
  await gone;
  assert.deepEqual(k.sent, [[-CLI, 'SIGKILL']], 'no tool shell is killed, even once the CLI has gone');
  // With another job found, its shell is its own, and the rest stay with the one that wasn’t.
  const k2 = fakeKill();
  const b = exitLater(k2);
  const r = await stopTurn(fakeChild(), {
    keep: [
      { id: 'x', command: 'npm run long' },
      { id: 'c', command: "sleep 170; echo 'pbx C'" },
    ],
    exited: b.exited,
    kill: k2.kill,
    list: async () => PS,
    pollMs: 2,
  });
  assert.deepEqual(
    r.kept.map((j) => [j.id, j.groups.map((g) => g.pgid)]),
    [
      ['x', [69282]],
      ['c', [69193]],
    ],
  );
  b.exit();
  await r.gone;
  assert.deepEqual(k2.sent, [[-CLI, 'SIGKILL']]);
});

test('#164: a job to keep with no tool shell left isn’t kept, and nothing else is killed', async () => {
  const k = fakeKill();
  const a = exitLater(k);
  const noShells = PS.filter((p) => p.pgid === CLI);
  const r = await stopTurn(fakeChild(), {
    keep: [{ id: 'x', command: 'npm run long' }],
    exited: a.exited,
    kill: k.kill,
    list: async () => noShells,
    pollMs: 2,
  });
  assert.deepEqual(r.kept, []);
  assert.deepEqual(k.sent, [[-CLI, 'SIGKILL']]);
  a.exit();
  await r.gone;
});

test('#126: the Kiro CLI starts in its own group too, and Stop signals the group', async () => {
  const child = fakeChild({ pid: 777 });
  const k = fakeKill();
  const spawned = [];
  const adapter = new KiroCliAdapter({
    bin: 'kiro-cli',
    workRoot: '/tmp/pb-test-work',
    isolatedHome: '/tmp/pb-test-kiro-home',
    spawnImpl: /** @type {any} */ (
      (_bin, _args, opts) => {
        spawned.push(opts);
        return child;
      }
    ),
    kill: k.kill,
    listProcesses: async () => [],
  });
  const ctx = fakeCtx({ persona: { handle: 'kiro', permissionMode: 'auto', folder: '/tmp/pb-test-kiro', usesHostSetup: false } });
  const done = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx);
  for (let i = 0; i < 50 && !spawned.length; i++) await sleep(5);
  assert.equal(spawned[0].detached, true);
  ctx.abort.abort();
  await sleep(5);
  assert.deepEqual(k.sent, [[-777, 'SIGINT']]);
  child.exit();
  await done;
});

test('#126: a launcher that exits on SIGINT while the CLI under it runs on: the group gets SIGKILL, and only then is it gone', async () => {
  // The spawned process (a shim) exits at once; the group stays until it gets SIGKILL.
  let groupUp = true;
  const sent = [];
  const kill = (pid, sig) => {
    if (sig === 0) {
      if (!groupUp) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      return true;
    }
    sent.push([pid, sig]);
    if (pid === -600 && sig === 'SIGKILL') groupUp = false;
    return true;
  };
  const { gone } = await stopTurn(fakeChild({ pid: 600 }), { exited: Promise.resolve(), kill, list: async () => [], graceMs: 20, pollMs: 2 });
  let ended = false;
  gone.then(() => {
    ended = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(ended, false, 'the shim has exited, but the group hasn’t');
  await gone;
  assert.deepEqual(sent, [
    [-600, 'SIGINT'],
    [-600, 'SIGKILL'],
  ]);
});

test('#126: the Claude Code adapter ends a stopped turn only once the CLI’s whole group has gone, not when the launcher exits', async () => {
  const child = fakeChild({ pid: 610 });
  let groupUp = true;
  const kill = (_pid, sig) => {
    if (sig === 0 && !groupUp) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    return true;
  };
  const adapter = new ClaudeCodeAdapter({
    bin: 'claude',
    workRoot: '/tmp/pb-test-work',
    spawnImpl: /** @type {any} */ (() => child),
    kill,
    listProcesses: async () => [],
  });
  const ctx = fakeCtx();
  let ended = false;
  const done = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx).then(() => {
    ended = true;
  });
  await sleep(5);
  ctx.abort.abort();
  await sleep(5);
  child.exit();
  await sleep(150);
  assert.equal(ended, false, 'the launcher exited; the CLI under it hasn’t');
  groupUp = false;
  await done;
});

test('#61: an Agent SDK failure keeps the CLI’s own reason, from the stderr Postbox reads for a process it spawned', async () => {
  const child = fakeChild({ pid: 920 });
  const sdk = {
    query({ options }) {
      const c = options.spawnClaudeCodeProcess({ command: 'claude', args: [], cwd: '/w', env: {} });
      return (async function* () {
        c.stderr.write('Error: Invalid model name\n');
        await new Promise((r) => setImmediate(r));
        yield* [];
        throw new Error('Claude Code process exited with code 1');
      })();
    },
  };
  const adapter = new AgentSdkAdapter({
    sdk,
    workRoot: '/tmp/pb-test-work',
    spawnImpl: /** @type {any} */ (() => child),
    kill: fakeKill().kill,
    listProcesses: async () => [],
  });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, fakeCtx()), /exited with code 1: Error: Invalid model name/);
});

test('#126: the Agent SDK’s CLI is spawned by Postbox, in its own group; Stop signals the group, and the turn ends once it exits', async () => {
  const child = fakeChild({ pid: 900 });
  const k = fakeKill();
  const spawned = [];
  const sdk = {
    query({ options }) {
      const c = options.spawnClaudeCodeProcess({ command: 'claude', args: ['-p'], cwd: '/w', env: {}, signal: new AbortController().signal });
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
        await new Promise((_r, rej) =>
          options.abortController.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
        );
        c.stdout.end();
      })();
    },
  };
  const adapter = new AgentSdkAdapter({
    sdk,
    workRoot: '/tmp/pb-test-work',
    spawnImpl: /** @type {any} */ (
      (_cmd, _args, opts) => {
        spawned.push(opts);
        return child;
      }
    ),
    kill: k.kill,
    listProcesses: async () => [],
  });
  const ctx = fakeCtx();
  let ended = false;
  const done = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx).then(() => {
    ended = true;
  });
  await until(() => spawned.length, 'the spawn');
  assert.equal(spawned[0].detached, true);
  ctx.abort.abort();
  await sleep(10);
  assert.deepEqual(k.sent, [[-900, 'SIGINT']]);
  assert.equal(ended, false, 'the turn waits for its CLI to exit');
  child.exit();
  await done;
  assert.equal(ended, true);
});

// ── Background jobs in the stream ─────────────────────────────────────────────────

const replay = (name) => {
  const ctx = fakeCtx();
  const m = createStreamMapper(ctx, { now: () => 1000 });
  const firstResult = [];
  for (const e of fixture(name)) {
    m.push(e);
    if (e.type === 'result' && !firstResult.length) firstResult.push(ctx.calls.activity.length);
  }
  return { ctx, afterFirstResult: ctx.calls.activity.slice(0, firstResult[0]) };
};

test('#129: a recorded background command stays running past the reply, and closes when the CLI says it completed', () => {
  const { ctx, afterFirstResult } = replay('background-done');
  const id = 'toolu_01U5ezQtB9rnpsgKjmvcsvHj';
  assert.equal(afterFirstResult.filter((a) => a.id === id).at(-1).state, 'running', 'not “done” when the call returns');
  assert.equal(afterFirstResult.filter((a) => a.id === id).at(-1).job, 'by2p2pps3');
  assert.equal(ctx.calls.activity.filter((a) => a.id === id).at(-1).state, 'done');
  assert.deepEqual(ctx.calls.jobs[0], {
    id: 'by2p2pps3',
    toolUseId: id,
    label: 'Run sleep then echo marker in background',
    command: 'sleep 25; echo pbxA2',
    outputFile: '/tmp/claude/-workspace-rec/f6b379f2-64c7-427b-a730-754b91ccc47a/tasks/by2p2pps3.output',
    state: 'running',
  });
  assert.deepEqual(ctx.calls.jobs.at(-1), { id: 'by2p2pps3', state: 'done' });
  assert.ok(ctx.calls.status.some((s) => s.currentStep === 'Waiting for a background job'));
});

test('#129 with #132: a background command reaches the work ledger too: its result when it starts, and how it ended', () => {
  const ended = [];
  const results = [];
  const ctx = fakeCtx({ taskEnded: (x) => ended.push(x), toolResult: (r) => results.push(r) });
  const m = createStreamMapper(ctx, { now: () => 1000 });
  for (const e of fixture('background-done')) m.push(e);
  const id = 'toolu_01U5ezQtB9rnpsgKjmvcsvHj';
  // The job’s own tracking and the ledger both hear the one task_notification.
  assert.deepEqual(ctx.calls.jobs.at(-1), { id: 'by2p2pps3', state: 'done' });
  assert.equal(ended.filter((x) => x.toolUseId === id).length, 1, 'the ledger doesn’t hear how the background command ended');
  assert.equal(ended.find((x) => x.toolUseId === id).status, 'completed');
  assert.ok(
    results.some((r) => r.id === id),
    'the ledger doesn’t get the result that started the job',
  );
});

test('#129: a recorded Stop (SIGINT) ends the job as stopped; one whose shell was killed ends as failed', () => {
  const stopped = replay('background-stopped').ctx;
  assert.deepEqual(stopped.calls.jobs.at(-1), { id: 'bm2939coh', state: 'stopped' });
  assert.equal(stopped.calls.jobs.length, 2, 'the foreground call isn’t a job');
  const failed = replay('background-failed').ctx;
  assert.deepEqual(failed.calls.jobs.at(-1), { id: 'brxptrhtn', state: 'failed' });
  assert.equal(failed.calls.activity.filter((a) => a.job === 'brxptrhtn').at(-1).state, 'failed');
});

// ── The runtime ───────────────────────────────────────────────────────────────────

/** An adapter scripted per turn, as in tests/runtime.test.mjs. */
class Scripted {
  name = 'mock';
  calls = [];
  next = [];
  async folderFor() {
    return null;
  }
  async deliver(_session, message, ctx) {
    this.calls.push({ message, ctx });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx, message);
  }
}

function setup() {
  const store = new Store(null);
  const adapter = new Scripted();
  const k = fakeKill();
  /** @type {import('../server/adapters/process-group.mjs').Proc[]} what a fake ps lists: the kept jobs’ shells */
  const procs = [];
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    signalProcess: k.kill,
    listProcesses: async () => procs,
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'developer' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { store, rt, adapter, t, se: rt.sessionsIn(t.id)[0], k, procs };
}
/** A kept job’s shell as ps shows it, leading its own group. */
const shellRow = (pgid, command) => ({ pid: pgid, ppid: 1, pgid, command: `/bin/zsh -c source snapshot.sh && eval '${command}' < /dev/null` });

/**
 * A turn that runs until it’s aborted, then “exits” only when the test says so, like a CLI that takes a while to stop.
 * kept: what the adapter reports for a job Stop kept running, or null when it found none to keep.
 */
function slowToExit({ job = null, kept = /** @type {object|null} */ ({ pgid: 4242 }) } = {}) {
  let exit = () => {};
  const exited = new Promise((r) => {
    exit = r;
  });
  const step = async (c) => {
    c.text('working');
    if (job) {
      c.activity({ id: 'tu_1', label: 'Run the UAT', state: 'running', job: job.id });
      c.job({ id: job.id, toolUseId: 'tu_1', label: 'Run the UAT', command: job.command, outputFile: '/tmp/out.txt', state: 'running' });
    }
    await new Promise((r) => c.signal.addEventListener('abort', r));
    step.reason = c.signal.reason;
    if (job && kept && c.signal.reason?.keepJobs?.length) c.job({ id: job.id, kept: true, ...kept });
    await exited;
  };
  step.exit = exit;
  return step;
}

test('#126: after Stop the session is stopping until the process exits, and a message sent meanwhile waits for it', async () => {
  const { rt, store, adapter, t, se } = setup();
  const first = slowToExit();
  adapter.next.push(first);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  assert.equal(rt.stop(se.id), true);
  assert.equal(store.state.sessions[se.id].state, 'stopping');
  rt.sendMessage(t.id, { text: 'next' });
  await sleep(10);
  assert.equal(adapter.calls.length, 1, 'no second process beside the first');
  first.exit();
  await sleep(10);
  assert.equal(adapter.calls.length, 2, 'the next turn starts once the first has exited');
  assert.equal(adapter.calls[1].message.text, 'next');
  await sleep(10);
  assert.equal(store.state.sessions[se.id].state, 'idle');
});

test('#126: Send now waits on the same exit', async () => {
  const { rt, adapter, t } = setup();
  const first = slowToExit();
  adapter.next.push(first);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  const { queued } = rt.sendMessage(t.id, { text: 'change of plan' });
  rt.sendQueuedNow(t.id, queued.id);
  await sleep(10);
  assert.equal(adapter.calls.length, 1);
  first.exit();
  await sleep(10);
  assert.equal(adapter.calls.at(-1).message.text, 'change of plan');
});

test('#126: a stopped turn’s tool calls are refused, and show nothing; the next turn’s still work, and a call without a token is refused (#54)', async () => {
  const { rt, store, adapter, t, se } = setup();
  const first = slowToExit();
  adapter.next.push(first);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  const token = new URL(adapter.calls[0].ctx.mcpUrl).searchParams.get('turn');
  assert.match(token ?? '', /^[0-9a-f-]{36}$/);
  const call = (
    tok,
    id,
    name = 'show_block',
    args = { block: { id: `b${id}`, type: 'confirm', version: 1, fallback: 'x', statement: 'Do it?', confirmLabel: 'Do it' } },
  ) => handleMcp(rt, se.id, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, tok);
  assert.equal((await call(token, 1)).result.isError, false, 'the running turn’s own call works');
  rt.stop(se.id);
  const blocks = () => store.items(t.id).filter((i) => i.kind === 'block').length;
  const before = blocks();
  const refused = await call(token, 2);
  assert.match(refused.error.message, /stopped or has ended/);
  assert.equal(blocks(), before, 'nothing of it reaches the conversation');
  const prompt = await call(token, 3, 'permission_prompt', { tool_name: 'Bash', input: { command: 'rm -rf x' } });
  assert.match(prompt.error.message, /stopped or has ended/, 'nor can it ask for permission');
  first.exit();
  adapter.next.push(async (c) => {
    await sleep(20);
    c.text('done');
  });
  rt.sendMessage(t.id, { text: 'again' });
  await sleep(10);
  const next = new URL(adapter.calls[1].ctx.mcpUrl).searchParams.get('turn');
  assert.notEqual(next, token, 'each turn has its own token');
  assert.equal((await call(next, 4)).result.isError, false);
  assert.equal((await call(token, 5)).error.code, -32001);
  // A script that knows only the session id can’t act as the agent (#54), and nothing of it is shown.
  const shown = blocks();
  const none = await call(null, 6);
  assert.equal(none.error.code, -32001);
  assert.match(none.error.message, /only from an agent turn it started/);
  assert.equal(blocks(), shown);
});

test('#129: Stop asks when background jobs run, and stops nothing until you answer', async () => {
  const { rt, store, adapter, t, se } = setup();
  const first = slowToExit({ job: { id: 'bgx1', command: 'node tools/uat-run.mjs' } });
  adapter.next.push(first);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  const r = rt.requestStop(se.id);
  assert.deepEqual(r.ask, { jobs: 1, text: '@developer has 1 background job running. Stop it too?', turnId: rt.turns.get(se.id).id });
  assert.equal(rt.turns.has(se.id), true, 'still running');
  assert.equal(store.state.sessions[se.id].stopAsk.text, r.ask.text, 'the ask shows in the conversation');
  rt.dismissStopAsk(se.id);
  assert.equal(store.state.sessions[se.id].stopAsk, null);
  assert.deepEqual(rt.requestStop(se.id, { jobs: 'stop' }), { stopped: true });
  await sleep(1);
  assert.deepEqual(first.reason.keepJobs, [], 'Stop it too: nothing kept');
  first.exit();
  await sleep(10);
  const step = store.items(t.id).find((i) => i.kind === 'agent').activity.steps[0];
  assert.equal(step.state, 'stopped');
  assert.deepEqual(store.state.sessions[se.id].jobs, []);
  // Without jobs, Stop doesn’t ask.
  adapter.next.push(slowToExit());
  rt.sendMessage(t.id, { text: 'again' });
  await sleep(5);
  assert.deepEqual(rt.requestStop(se.id), { stopped: true });
});

test('#129: Keep running and Send now keep the job, listed with its own Stop, and the next turn hears it’s still running', async () => {
  const { rt, store, adapter, t, se, k, procs } = setup();
  const first = slowToExit({ job: { id: 'bgx2', command: 'node tools/uat-run.mjs' } });
  adapter.next.push(first);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  // Send now, without asking.
  rt.sendMessage(t.id, { text: 'change of plan', sendNow: true });
  await sleep(1);
  assert.deepEqual(first.reason.keepJobs, [{ id: 'bgx2', command: 'node tools/uat-run.mjs' }]);
  first.exit();
  await sleep(15);
  const next = adapter.calls[1].message;
  assert.equal(next.text, 'change of plan');
  assert.match(next.context.join('\n'), /^\[Postbox\] Your background job bgx2 \(`node tools\/uat-run\.mjs`\) is still running.*\/tmp\/out\.txt/m);
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.activity?.steps?.length);
  assert.equal(reply.activity.steps[0].state, 'running', 'the job’s step is still running');
  assert.deepEqual(
    store.state.sessions[se.id].jobs.map((j) => [j.id, j.kept, j.pgid]),
    [['bgx2', true, 4242]],
  );
  // Its own Stop signals its group, once ps shows the group is still the job’s, and the agent hears it on its next turn.
  procs.push(shellRow(4242, 'node tools/uat-run.mjs'));
  await rt.stopJob(se.id, 'bgx2');
  assert.deepEqual(k.sent, [[-4242, 'SIGINT']]);
  assert.equal(store.item(t.id, reply.id).activity.steps[0].state, 'stopped');
  assert.match(store.state.sessions[se.id].context.at(-1), /bgx2 .* was stopped by the person/);
  await assert.rejects(rt.stopJob(se.id, 'bgx2'), /already ended/);
});

test('#129: a kept job whose group is gone has ended; shutting down stops the ones still running', async () => {
  const { rt, store, adapter, t, se, k, procs } = setup();
  for (const id of ['bgA', 'bgB']) {
    const s = slowToExit({ job: { id, command: `job ${id}` } });
    adapter.next.push(s);
    rt.sendMessage(t.id, { text: id });
    await sleep(5);
    rt.stop(se.id, { jobs: 'keep' });
    s.exit();
    await sleep(10);
  }
  assert.equal(store.state.sessions[se.id].jobs.length, 2);
  // Both report pgid 4242 here: ps shows bgB’s shell there, so bgA has ended.
  procs.push(shellRow(4242, 'job bgB'));
  await rt.pollKept();
  assert.deepEqual(
    store.state.sessions[se.id].jobs.map((j) => j.id),
    ['bgB'],
  );
  assert.match(store.state.sessions[se.id].context.join('\n'), /bgA .* has ended/);
  await rt.stopTurns({ graceMs: 10 });
  assert.deepEqual(k.sent.at(-1), [-4242, 'SIGINT']);
  assert.deepEqual(store.state.sessions[se.id].jobs, []);
  assert.equal(rt.keptPoll, null);
});

test('#129: a kept job’s group id taken by another process isn’t signaled', async () => {
  const { rt, store, adapter, t, se, k, procs } = setup();
  const s = slowToExit({ job: { id: 'bgC', command: 'job bgC' } });
  adapter.next.push(s);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  rt.stop(se.id, { jobs: 'keep' });
  s.exit();
  await sleep(10);
  procs.push(shellRow(4242, 'something else entirely'));
  await rt.stopJob(se.id, 'bgC');
  assert.deepEqual(k.sent, [], 'not the job’s any more');
  assert.deepEqual(store.state.sessions[se.id].jobs, []);
});

test('#164: a kept job’s groups stay its own while their leaders’ command lines are unchanged, and aren’t signaled once taken', async () => {
  const { rt, store, adapter, t, se, k, procs } = setup();
  const a = shellRow(4242, LOOP);
  const b = shellRow(4343, 'sleep 600');
  const s = slowToExit({ job: { id: 'bgG', command: LOOP_JOB }, kept: { pgid: 4242, groups: [a, b].map((p) => ({ pgid: p.pgid, command: p.command })) } });
  adapter.next.push(s);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  rt.stop(se.id, { jobs: 'keep' });
  s.exit();
  await sleep(10);
  const [job] = store.state.sessions[se.id].jobs;
  assert.deepEqual([job.kept, job.pgid, job.groups.length], [true, 4242, 2]);
  // Postbox couldn’t tell which was the job: the step and the agent both hear it kept them all.
  const step = () => store.items(t.id).find((i) => i.kind === 'agent' && i.activity?.steps?.length).activity.steps[0];
  assert.equal(step().state, 'running');
  assert.match(step().detail, /^Postbox couldn’t tell which of 2 processes is this job, so it kept them all running/);
  assert.match(store.state.sessions[se.id].context.at(-1), /bgG .* is still running: .*couldn’t tell which of 2 processes/);
  // The leaders are as they were at Stop, though the loop isn’t what the job’s command says: still running.
  procs.push(a, b);
  await rt.pollKept();
  assert.equal(store.state.sessions[se.id].jobs.length, 1);
  // 4343 has gone and its id has gone to another process: only 4242 is signaled.
  procs.splice(1, 1, shellRow(4343, 'something else entirely'));
  await rt.stopJob(se.id, 'bgG');
  assert.deepEqual(k.sent, [[-4242, 'SIGINT']]);
  assert.equal(step().state, 'stopped');
  assert.equal(step().detail, null, 'it no longer says what was kept');
});

test('#164: a kept job saved before groups were recorded, with only its pgid, is still checked by its command and stopped', async () => {
  const { rt, store, t, se, k, procs } = setup();
  rt.updateSession(se.id, {
    jobs: [
      {
        id: 'bgO',
        sessionId: se.id,
        turnId: 'turn_old',
        threadId: t.id,
        itemId: null,
        toolUseId: 'tu_o',
        label: 'Old',
        command: 'job bgO',
        outputFile: null,
        startedAt: Date.now(),
        state: 'running',
        kept: true,
        pgid: 4242,
      },
    ],
  });
  procs.push(shellRow(4242, 'job bgO'));
  await rt.pollKept();
  assert.equal(store.state.sessions[se.id].jobs.length, 1, 'its leader runs its command: still running');
  await rt.stopJob(se.id, 'bgO');
  assert.deepEqual(k.sent, [[-4242, 'SIGINT']]);
  assert.deepEqual(store.state.sessions[se.id].jobs, []);
});

test('#164: a job Stop couldn’t keep, with no process left to keep, ends as stopped, and its step says so', async () => {
  const { rt, store, adapter, t, se, k } = setup();
  const s = slowToExit({ job: { id: 'bgL', command: 'npm run long' }, kept: null });
  adapter.next.push(s);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  rt.stop(se.id, { jobs: 'keep' });
  s.exit();
  await sleep(10);
  assert.deepEqual(store.state.sessions[se.id].jobs, []);
  const step = store.items(t.id).find((i) => i.kind === 'agent' && i.activity?.steps?.length).activity.steps[0];
  assert.equal(step.state, 'stopped');
  assert.match(step.detail, /^Postbox couldn’t find its process to keep it running/);
  assert.deepEqual(k.sent, []);
});

test('#129: deleting a session for good stops the jobs Postbox kept running for it', async () => {
  const { rt, adapter, t, se, k, procs } = setup();
  const s = slowToExit({ job: { id: 'bgD', command: 'job bgD' } });
  adapter.next.push(s);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  rt.stop(se.id, { jobs: 'keep' });
  s.exit();
  await sleep(10);
  procs.push(shellRow(4242, 'job bgD'));
  rt.deleteSession(se.id);
  rt.purgeSession(se.id);
  await sleep(5);
  assert.deepEqual(k.sent, [[-4242, 'SIGINT']]);
});

test('#126: an answer to a Stop ask about a turn that has ended stops nothing', async () => {
  const { rt, adapter, t, se } = setup();
  adapter.next.push(slowToExit({ job: { id: 'bgE', command: 'job bgE' } }));
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  const { ask } = rt.requestStop(se.id);
  assert.ok(ask.turnId);
  assert.deepEqual(rt.requestStop(se.id, { jobs: 'stop', turnId: 'turn_older' }), { stopped: false, ended: true });
  assert.equal(rt.turns.has(se.id), true);
  assert.deepEqual(rt.requestStop(se.id, { jobs: 'stop', turnId: ask.turnId }), { stopped: true });
});

test('#126: shutting down starts no new turn: a message held for a stopped turn waits in the queue', async () => {
  const { rt, store, adapter, t, se } = setup();
  const first = slowToExit();
  adapter.next.push(first);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  rt.stop(se.id);
  rt.sendMessage(t.id, { text: 'after the restart' });
  const closing = rt.stopTurns({ graceMs: 500 });
  first.exit();
  await closing;
  assert.equal(adapter.calls.length, 1, 'no CLI started as Postbox shuts down');
  assert.deepEqual(
    store.state.threads[t.id].queue.map((q) => q.text),
    ['after the restart'],
  );
});
