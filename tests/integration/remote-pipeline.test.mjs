// A remote turn through the whole pipeline, with only ssh replaced (#120, V1). A real Runtime and the real host manager
// (server/remote/hosts.mjs), with the real Claude Code adapter, links and remote process; their ssh `spawn` runs ssh’s
// last argument with /bin/sh -c and a temp folder as HOME, as sshd hands the remote command to the login shell. So
// Postbox installs its host code there (rt.installHost: the install script and the token step through the launcher),
// and each session runs the installed `host attach`, which starts the real `host serve`; the daemon starts the real
// runner, which starts the harness, which starts the real shim. The harness is tests/fixtures/remote/claude-standin.mjs,
// the host’s claudePath: a stand-in that speaks MCP to the shim and replays recorded Claude Code lines (its header says
// which). Nothing listens on TCP or touches the network, the real home folder or ~/.postbox-remote.
//
// What it checks, each as its own test: a turn that streams, shows a block, asks and is allowed, then ends Done; an ssh
// drop mid-turn; the daemon killed mid-turn; Postbox restarted mid-turn; Stop; a prompt that expires; and a turn whose
// runner is killed, which is Interrupted and resumes on its own. “No line applied twice” is checked exactly: the adapter
// records every line it applies (POSTBOX_CLAUDE_RECORD), and that must be the stand-in’s stdout, line for line. Every
// process a test starts is gone when it ends (on Linux, also every process /proc finds with the test’s marker). It runs
// in a container with no init too: a killed daemon nobody reaps stays a zombie, which proc.mjs’s sameProcess counts as
// gone, so the next attach starts a new daemon.

import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../../server/adapters/claude-code.mjs';
import { hostVersion } from '../../server/remote/host/paths.mjs';
import { createHostManager } from '../../server/remote/hosts.mjs';
import { remoteCommand } from '../../server/remote/ssh.mjs';
import { Runtime } from '../../server/runtime.mjs';
import { Store } from '../../server/store.mjs';
import { hostPaths, TURN_FILES } from '../../shared/remote-protocol.mjs';
import { FIXTURES, gone, NO_UNIX, sleep, until } from './host.mjs';

const VERSION = hostVersion();
const HOST = 'host.example.com';
const NODE_DIR = dirname(process.execPath);
const STANDIN = join(FIXTURES, 'claude-standin.mjs');
const LINUX = process.platform === 'linux';
/** Every process this file starts has it in its environment, for the /proc sweep at the end. */
const RUN = `v1-${randomUUID()}`;
const TEST = { skip: NO_UNIX, timeout: 90_000 };
const BLOCK_ID = 'pick';

const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
const recorded = (name) =>
  readFileSync(join(FIXTURES, '..', 'claude-code', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
/**
 * The reply a recorded turn makes once its stream is applied whole: its text deltas, or with none (a recording without
 * partial messages), its assistant messages’ text.
 */
function replyOf(name) {
  const events = recorded(name);
  const deltas = events.filter((e) => e.event?.delta?.type === 'text_delta').map((e) => e.event.delta.text);
  if (deltas.length) return deltas.join('');
  return events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => e.message.content.filter((c) => c.type === 'text').map((c) => c.text))
    .join('');
}

// ── The two machines ────────────────────────────────────────────────────────────────

/**
 * A host home and a laptop data folder under one temp folder, and the spawn that stands in for ssh. Each session is
 * kept with what crossed it: `sent`, the messages Postbox wrote, and `got`, the daemon’s.
 * @param {{ timings?: Record<string, number> }} [o]  POSTBOX_SHIM_TIMINGS for the shim (it can only shorten its waits)
 */
function machine({ timings = {} } = {}) {
  const root = mkdtempSync('/tmp/pbv-'); // not os.tmpdir(): macOS’s pushes the sockets’ paths past sun_path
  const home = join(root, 'h');
  const trace = join(root, 'trace');
  const applied = join(root, 'applied');
  for (const d of [home, trace, applied]) mkdirSync(d);
  // The host’s claude: a wrapper that execs the stand-in with this node, as an installer’s launcher would.
  const claude = join(home, 'bin', 'claude');
  mkdirSync(dirname(claude));
  for (const p of [process.execPath, STANDIN]) assert.ok(!p.includes("'"), `${p} has a quote the wrapper can’t hold`);
  writeFileSync(claude, `#!/bin/sh\nexec '${process.execPath}' '${STANDIN}' "$@"\n`, { mode: 0o755 });
  const mark = `${RUN}-${randomUUID().slice(0, 8)}`;
  const env = {
    HOME: home,
    POSTBOX_REMOTE_HOME: home,
    PATH: `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
    POSTBOX_STANDIN_TRACE: trace,
    POSTBOX_SHIM_TIMINGS: JSON.stringify({ progress: 300, ...timings }),
    POSTBOX_V1_RUN: mark,
  };
  /** @type {{ child: import('node:child_process').ChildProcess, attach: boolean, sent: any[], got: any[] }[]} */
  const sessions = [];
  const m = {
    root,
    home,
    trace,
    applied,
    claude,
    mark,
    env,
    sessions,
    data: join(root, 'data'),
    paths: hostPaths(home, VERSION),
    /** The reconnect backoff, per attempt; a test lengthens it to hold a drop open. */
    delay: 50,
    /** PIDs seen, which must all be gone at the end. @type {Map<number, string>} */
    pids: new Map(),
    /** @type {(program: string, args: string[], options: object) => import('node:child_process').ChildProcess} */
    spawn: (program, args, options) => {
      assert.equal(program, 'ssh');
      // Its own group, so a drop can kill the shell and the attach it runs together.
      const child = nodeSpawn('/bin/sh', ['-c', args.at(-1)], { ...options, env, detached: true });
      const s = { child, attach: args.at(-1) === remoteCommand(VERSION), sent: /** @type {any[]} */ ([]), got: /** @type {any[]} */ ([]) };
      sessions.push(s);
      m.pids.set(/** @type {number} */ (child.pid), 'an ssh session');
      if (s.attach) {
        const write = child.stdin?.write.bind(child.stdin);
        if (child.stdin && write)
          child.stdin.write = /** @type {any} */ (
            (chunk, ...rest) => {
              for (const l of String(chunk).split('\n')) if (l) s.sent.push(JSON.parse(l));
              return write(chunk, ...rest);
            }
          );
        let buf = '';
        child.stdout?.on('data', (b) => {
          buf += b;
          const end = buf.lastIndexOf('\n') + 1;
          s.got.push(...wholeLines(buf.slice(0, end)));
          buf = buf.slice(end);
        });
      }
      return child;
    },
  };
  process.env.POSTBOX_CLAUDE_RECORD = applied;
  return m;
}

/** A file’s whole lines, as JSON: one still being written, past its last \n, waits for the next look. @param {string} text */
const wholeLines = (text) =>
  text
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** The stand-in’s runs so far, oldest first: their events and the lines each wrote. @param {ReturnType<typeof machine>} m */
function standins(m) {
  return readdirSync(m.trace)
    .filter((f) => /^\d+\.jsonl$/.test(f))
    .map((f) => {
      const events = wholeLines(readFileSync(join(m.trace, f), 'utf8'));
      const pid = Number(f.split('.')[0]);
      const out = join(m.trace, `${pid}.out.jsonl`);
      return { pid, events, start: events[0], out: existsSync(out) ? readFileSync(out, 'utf8') : '', has: (ev) => events.find((e) => e.ev === ev) };
    })
    .filter((s) => s.start)
    .sort((a, b) => a.start.at - b.start.at);
}

/** What the adapter applied, one file per run, oldest first (the adapter names them by time). @param {ReturnType<typeof machine>} m */
const appliedRuns = (m) =>
  readdirSync(m.applied)
    .sort()
    .map((f) => readFileSync(join(m.applied, f), 'utf8'));

/** The daemon’s PID, from daemon.pid, or null. @param {ReturnType<typeof machine>} m */
function daemonPid(m) {
  try {
    return JSON.parse(readFileSync(join(m.paths.code, 'daemon.pid'), 'utf8')).pid;
  } catch {
    return null;
  }
}

const alive = (pid) => !gone(pid);
/** Whether a PID is a zombie, from /proc (Linux only). @param {number} pid */
function zombie(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z';
  } catch {
    return false;
  }
}

/**
 * Every process with the machine’s marker in its environment that isn’t a zombie, from /proc (Linux only).
 * @param {string} mark @returns {number[]}
 */
function marked(mark) {
  const name = 'POSTBOX_V1_RUN=';
  const found = [];
  for (const pid of readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d))
    .map(Number)) {
    if (pid === process.pid || zombie(pid)) continue;
    try {
      if (
        readFileSync(`/proc/${pid}/environ`, 'utf8')
          .split('\0')
          .some((v) => v.startsWith(name) && v.slice(name.length).startsWith(mark))
      )
        found.push(pid);
    } catch {}
  }
  return found;
}

/**
 * Ends what a test left: its Postboxes (turns on the host aren’t stopped by that) and the daemon, with SIGTERM as a
 * person’s `kill` would. Then every PID it saw, and on Linux every marked process, must be gone; anything left is a
 * stray, and is killed so nothing outlives the test. Returns the strays.
 * @param {ReturnType<typeof machine>} m @param {any[]} postboxes
 */
async function teardown(m, postboxes) {
  for (const p of postboxes) await p.done().catch(() => {});
  delete process.env.POSTBOX_CLAUDE_RECORD;
  for (const s of standins(m)) {
    m.pids.set(s.pid, 'a stand-in claude');
    const shim = s.has('shim')?.pid;
    if (shim) m.pids.set(shim, 'a shim');
  }
  const daemon = daemonPid(m);
  if (daemon) {
    m.pids.set(daemon, 'the daemon');
    try {
      process.kill(daemon, 'SIGTERM');
    } catch {}
  }
  const end = Date.now() + 10_000;
  const left = () => [...m.pids.keys()].filter(alive);
  while (left().length && Date.now() < end) await sleep(50);
  /** @type {Map<number, string>} */
  const strays = new Map(left().map((pid) => [pid, `${m.pids.get(pid)} (${pid})`]));
  if (LINUX) for (const pid of marked(m.mark)) if (!strays.has(pid)) strays.set(pid, `a process with the test’s marker (${pid})`);
  // Whatever is left goes now, by group where it leads one.
  for (const pid of strays.keys())
    for (const target of [-pid, pid])
      try {
        process.kill(target, 'SIGKILL');
      } catch {}
  rmSync(m.root, { recursive: true, force: true });
  return [...strays.values()];
}

/** Runs a test on a fresh pair of machines and checks that nothing it started is left. */
async function onMachines(opts, fn) {
  const m = machine(opts);
  /** @type {any[]} */
  const postboxes = [];
  let failed = null;
  try {
    await fn(m, postboxes);
  } catch (e) {
    failed = e;
  }
  const strays = await teardown(m, postboxes);
  if (failed) throw failed;
  assert.deepEqual(strays, [], 'every process the test started is gone once Postbox and the daemon have closed');
}

// ── Postbox ─────────────────────────────────────────────────────────────────────────

/** A local kill, ps and spawn that fail the test if they’re ever called: a remote turn uses none of them. */
function forbidden() {
  const calls = [];
  const no =
    (what) =>
    (...a) => {
      calls.push([what, ...a]);
      throw new Error(`A remote turn used this computer’s ${what}.`);
    };
  return { calls, kill: no('kill'), listProcesses: async () => no('ps')(), spawnImpl: no('spawn') };
}

/**
 * A Postbox on `store`, whose host manager’s ssh is the machine’s spawn. A new store gets the host (installed there by
 * rt.installHost), a Claude Code persona placed on it that asks before acting, and a thread; a store from before (a
 * restart) has them.
 * @param {ReturnType<typeof machine>} m @param {any[]} postboxes @param {Store} [store]
 */
async function postbox(m, postboxes, store = new Store(null)) {
  const f = forbidden();
  const claude = new ClaudeCodeAdapter({
    bin: 'claude',
    workRoot: '/tmp/pb-remote-never',
    spawnImpl: f.spawnImpl,
    kill: f.kill,
    listProcesses: f.listProcesses,
  });
  /** @type {Runtime} */
  let rt;
  const hosts = createHostManager({
    getHost: (id) => rt.s.hosts?.[id] ?? null,
    hostIds: () => Object.keys(rt.s.hosts ?? {}),
    dataDir: m.data,
    version: VERSION,
    spawn: /** @type {any} */ (m.spawn),
    delay: () => m.delay,
  });
  rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(claude),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, build: { version: VERSION } },
    hosts,
  });
  let closed = false;
  const p = {
    rt,
    store,
    hosts,
    f,
    host: /** @type {any} */ (Object.values(store.state.hosts ?? {})[0]),
    t: /** @type {any} */ (null),
    se: () => rt.sessionsIn(p.t.id)[0],
    async done() {
      if (closed) return;
      closed = true;
      await rt.stopTurns({ graceMs: 50 });
      hosts.close();
    },
  };
  postboxes.push(p);
  if (!p.host) {
    store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
    p.host = rt.addHost({ name: HOST, settings: { claudePath: m.claude, detach: 'setsid' } });
    const installed = await rt.installHost(p.host.id);
    assert.deepEqual(installed, { ok: true, installed: true, version: VERSION });
    const persona = rt.createPersona({ handle: 'coder', backend: 'claude-code', remote: { hostId: p.host.id } });
    store.emit('persona', { ...rt.persona(persona.id), permissionMode: 'ask' });
    rt.createThread({ projectId: 'p1', title: 'T', personaIds: [persona.id] });
  }
  p.t = Object.values(store.state.threads)[0];
  return p;
}

/** The session’s replies that count: not the ones a replay replaced. */
const replies = (p) => p.store.items(p.t.id).filter((i) => i.kind === 'agent' && i.sessionId === p.se().id && i.status !== 'replaced');
const replyText = (p) =>
  replies(p)
    .map((i) => i.text ?? '')
    .join('');
const blocks = (p) => p.store.items(p.t.id).filter((i) => i.kind === 'block' && i.block?.id === BLOCK_ID);
const cards = (p) => p.store.items(p.t.id).filter((i) => i.kind === 'permission');
const settled = (p) => until(() => !p.rt.turns.size && !p.rt.exiting.size, 'the turn to end', 20_000);
/** The postbox-to-daemon messages of a type, across every session. */
const sentOf = (m, type) => m.sessions.flatMap((s) => s.sent.filter((x) => x.type === type));

/**
 * Sends a message and waits for the stand-in it starts on the host; records its runner’s PID.
 * @returns {Promise<{ run: ReturnType<typeof standins>[number], turn: string, runner: number }>}
 */
async function started(m, p, text) {
  const before = standins(m).length;
  p.rt.sendMessage(p.t.id, { text });
  const run = await until(() => standins(m)[before], 'the stand-in to start on the host', 30_000);
  return { run, ...(await runnerOf(m, p)) };
}

/** The current host turn and its runner’s PID, from runner.json. */
async function runnerOf(m, p) {
  const turn = p.se().remoteTurn.turn;
  const runner = await until(() => {
    try {
      return JSON.parse(readFileSync(m.paths.turn(turn, TURN_FILES.runner), 'utf8')).pid;
    } catch {
      return null;
    }
  }, 'runner.json');
  m.pids.set(runner, 'a runner');
  return { turn, runner };
}

/** Waits for the stand-in’s event. */
const heard = (m, pid, ev, ms = 20_000) =>
  until(
    () =>
      standins(m)
        .find((s) => s.pid === pid)
        ?.has(ev),
    `the stand-in’s ${ev}`,
    ms,
  );

/** Waits for the turn’s permission card, and allows it as the page’s Allow does. */
async function allow(m, p, pid) {
  const card = await until(() => cards(p).find((i) => i.status === 'open' && i.remote?.turn === p.se().remoteTurn.turn), 'the permission card');
  p.rt.resolvePermission(p.t.id, card.id, 'allow');
  return (await heard(m, pid, 'decision')).decision;
}

/** A turn of scenario `gate`, allowed, and now running its Bash call until the test opens the gate. */
async function atGate(m, p) {
  const s = await started(m, p, 'Write hello to a file. standin:gate');
  await allow(m, p, s.run.pid);
  await heard(m, s.run.pid, 'gate');
  return s;
}
const open = (m) => writeFileSync(join(m.trace, 'go'), '');

/** The stand-in’s whole stdout is what the adapter applied in its last run: each line once, in order. */
function appliedOnce(m, label) {
  const runs = appliedRuns(m);
  const written = standins(m).at(-1)?.out;
  assert.ok(written, 'the stand-in wrote its stream');
  assert.equal(runs.at(-1), written, `${label}: every line the stand-in wrote was applied, once, in order`);
}

// ── The tests ───────────────────────────────────────────────────────────────────────

test('#120 pipeline: a remote Claude Code turn streams in, shows its block, asks, is allowed from the runtime, and ends Done', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await started(m, p, 'Write hello to a file. standin:allow');
    assert.equal(s.run.start.resumeInterrupted, null);
    // The shim was started exactly as --mcp-config said: the host’s node, the installed shim.mjs and the turn.
    assert.deepEqual([s.run.start.server.type, s.run.start.server.command, s.run.start.server.args], ['stdio', process.execPath, [m.paths.shim, s.turn]]);
    const mcp = await heard(m, s.run.pid, 'mcp');
    assert.equal(mcp.name, 'postbox');
    assert.ok(mcp.tools.includes('show_block') && mcp.tools.includes('permission_prompt'), 'the shim lists Postbox’s tools');
    // The block came through the shim, the daemon and the link, and shows once.
    await until(() => blocks(p).length === 1, 'the block');
    // The prompt is the laptop’s card, waiting; the shim’s progress kept the call alive meanwhile.
    await until(() => p.se().remoteTurn.state === 'waiting', 'Waiting on you');
    await heard(m, s.run.pid, 'progress');
    const decision = await allow(m, p, s.run.pid);
    assert.deepEqual(decision, { behavior: 'allow', updatedInput: (await heard(m, s.run.pid, 'decision')).asked });
    await heard(m, s.run.pid, 'end');
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
    const reply = replies(p).filter((i) => i.text);
    assert.deepEqual(
      reply.map((i) => i.status),
      ['done'],
    );
    assert.equal(replyText(p), replyOf('permission-allow'));
    assert.equal(blocks(p).length, 1, 'the block once');
    assert.equal(cards(p).length, 1);
    assert.match(cards(p)[0].status, /^allowed/);
    appliedOnce(m, 'one run');
    // The turn’s processes on the host have gone with it.
    const shim = (await heard(m, s.run.pid, 'shim')).pid;
    await until(() => [s.run.pid, s.runner, shim].every(gone), 'the turn’s processes to exit');
    assert.equal(sentOf(m, 'start').length, 1);
    assert.deepEqual(p.f.calls, [], 'nothing ran on this computer');
  }),
);

test('#120 pipeline: an ssh drop mid-turn leaves the turn running on the host; the link reconnects and reads on, no line applied twice', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await atGate(m, p);
    const first = m.sessions.filter((x) => x.attach).at(-1);
    assert.ok(first);
    // The transport dies: the ssh session’s whole group, SIGKILL. The next session waits out a longer backoff, so the
    // turn runs a while with nobody connected.
    m.delay = 1500;
    const written = standins(m).at(-1)?.out.length ?? 0;
    process.kill(-(/** @type {number} */ (first.child.pid)), 'SIGKILL');
    await until(() => p.rt.hostStatus(p.host.id).state !== 'connected', 'the link to see the drop');
    await until(() => (standins(m).at(-1)?.out.length ?? 0) > written + 200, 'the turn to write on with nobody connected');
    assert.ok(alive(s.runner) && alive(s.run.pid), 'the runner and the harness are still running');
    await until(() => p.rt.hostStatus(p.host.id).state === 'connected', 'the link to reconnect', 20_000);
    m.delay = 50;
    const second = m.sessions.filter((x) => x.attach).at(-1);
    assert.notEqual(second, first, 'a new session');
    // It reads on from where it had got to, not from the start.
    const read = await until(() => second?.sent.find((x) => x.type === 'read' && x.turn === s.turn && !x.log), 'the read on the new session');
    const acked = Math.max(0, ...first.sent.filter((x) => x.type === 'ack' && x.turn === s.turn).map((x) => x.upTo));
    assert.ok(read.from > 0 && read.from >= acked, `read from ${read.from}, past the last ack (${acked})`);
    open(m);
    await heard(m, s.run.pid, 'end');
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
    assert.equal(replyText(p), replyOf('permission-allow'));
    appliedOnce(m, 'across the drop');
    assert.equal(sentOf(m, 'start').length, 1, 'started once');
    assert.equal(blocks(p).length, 1);
    await until(() => [s.run.pid, s.runner].every(gone), 'the turn’s processes to exit');
  }),
);

test('#120 pipeline: the daemon killed mid-turn; the runner survives, the next attach starts a new daemon, and the turn goes on', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await atGate(m, p);
    const old = daemonPid(m);
    assert.ok(old && alive(old), 'a daemon serves');
    m.pids.set(old, 'the first daemon');
    const sessions = m.sessions.length;
    process.kill(old, 'SIGKILL');
    await until(() => gone(old), 'the daemon to die');
    // The daemon was detached, so it’s an orphan for PID 1 to reap. Where PID 1 doesn’t (a container with no init), it
    // stays a zombie, which daemon.pid’s owner check counts as gone, so a new daemon still starts.
    // Its attach relay ends with it, and the link’s next session starts `host serve` again.
    await until(() => m.sessions.length > sessions && p.rt.hostStatus(p.host.id).state === 'connected', 'a new session', 20_000);
    const fresh = await until(() => {
      const pid = daemonPid(m);
      return pid !== old && pid && alive(pid) ? pid : null;
    }, 'a new daemon');
    assert.notEqual(fresh, old);
    assert.ok(alive(s.runner) && alive(s.run.pid), 'the runner and the harness lived through it');
    const welcome = await until(() => m.sessions.at(-1)?.got.find((x) => x.type === 'welcome'), 'the new daemon’s welcome');
    assert.equal(welcome.turns.find((t) => t.turn === s.turn)?.state, 'running', 'it found the turn running');
    open(m);
    await heard(m, s.run.pid, 'end');
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
    assert.equal(replyText(p), replyOf('permission-allow'));
    appliedOnce(m, 'across the daemon’s restart');
    assert.equal(sentOf(m, 'start').length, 1);
    await until(() => [s.run.pid, s.runner].every(gone), 'the turn’s processes to exit');
  }),
);

test('#120 pipeline: Postbox restarts mid-turn; the new one attaches to the turn on the host and replays it, with nothing twice', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const store = new Store(null);
    const first = await postbox(m, postboxes, store);
    const s = await atGate(m, first);
    await until(() => blocks(first).length === 1 && replyText(first).length === 0, 'the block, before any reply text');
    // Postbox shuts down: the remote turn goes on on the host, and its ssh sessions end.
    await first.done();
    await until(() => m.sessions.every((x) => x.child.exitCode !== null || x.child.signalCode !== null), 'its ssh sessions to end');
    assert.equal(store.state.sessions[first.se().id].remoteTurn.turn, s.turn, 'the host turn is kept with the session');
    assert.ok(alive(s.runner) && alive(s.run.pid), 'the turn runs on');
    const before = m.sessions.length;

    // A new Postbox on the same store, starting up as server/index.mjs does.
    const second = await postbox(m, postboxes, store);
    for (const se of Object.values(store.state.sessions))
      if (['think', 'gen', 'tool', 'stopping'].includes(se.state)) second.rt.updateSession(se.id, { state: 'idle', currentStep: 'Interrupted by a restart' });
    for (const [threadId, list] of Object.entries(store.state.items))
      for (const it of list) if (it.status === 'streaming') second.rt.patchItem(threadId, it.id, { status: 'stopped' });
    second.rt.expireStalePermissions();
    second.rt.restoreRemoteTurns();
    second.rt.watchHosts();
    const read = await until(
      () =>
        m.sessions
          .slice(before)
          .flatMap((x) => x.sent)
          .find((x) => x.type === 'read' && x.turn === s.turn && !x.log),
      'the attach’s read',
    );
    assert.equal(read.from, 0, 'replayed from the start');
    open(m);
    await heard(m, s.run.pid, 'end');
    await settled(second);
    assert.equal(second.se().remoteTurn.state, 'done');
    // The reply is the one the stream makes in one go: what showed before the restart was replaced, not added to.
    assert.equal(replyText(second), replyOf('permission-allow'));
    assert.deepEqual(
      replies(second)
        .filter((i) => i.text)
        .map((i) => i.status),
      ['done'],
    );
    assert.equal(blocks(second).length, 1, 'the block once');
    assert.equal(cards(second).length, 1, 'the card once');
    assert.equal(sentOf(m, 'start').length, 1, 'attached, not started again');
    const runs = appliedRuns(m);
    assert.equal(runs.length, 2, 'one run before the restart, one after');
    appliedOnce(m, 'the replay');
    assert.ok(runs.at(-1)?.startsWith(/** @type {string} */ (runs[0])), 'what was applied before the restart is where the replay began');
    await until(() => [s.run.pid, s.runner].every(gone), 'the turn’s processes to exit');
  }),
);

test('#120 pipeline: Stop sends SIGINT to the host’s stand-in, which ends its turn, and no process of the turn is left', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await atGate(m, p);
    const shim = (await heard(m, s.run.pid, 'shim')).pid;
    assert.ok([s.runner, s.run.pid, shim].every(alive));
    assert.equal(p.rt.stop(p.se().id), true);
    await heard(m, s.run.pid, 'sigint');
    await settled(p);
    await until(() => [s.runner, s.run.pid, shim].every(gone), 'the runner, the stand-in and the shim to exit', 15_000);
    assert.equal(p.se().remoteTurn.state, 'done');
    assert.equal(sentOf(m, 'stop').filter((x) => x.turn === s.turn).length >= 1, true, 'the stop went to the daemon');
    // Its last line is the result Claude Code writes when SIGINT ends a turn.
    const last = JSON.parse(standins(m).at(-1)?.out.trim().split('\n').at(-1) ?? '{}');
    assert.deepEqual([last.type, last.subtype], ['result', 'error_during_execution']);
    assert.ok(
      replies(p).some((i) => i.status === 'stopped'),
      'the reply says it was stopped',
    );
    assert.deepEqual(p.f.calls, [], 'nothing was signaled on this computer');
  }),
);

test('#120 pipeline: a prompt nobody answers expires on the host; its card ends Expired and the stand-in is denied', TEST, () =>
  onMachines({ timings: { waitMax: 2000 } }, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await started(m, p, 'Delete the test file. standin:deny');
    await until(() => cards(p).some((i) => i.status === 'open'), 'the permission card');
    const { decision } = await heard(m, s.run.pid, 'decision');
    assert.equal(decision.behavior, 'deny');
    assert.match(decision.message, /^Nobody answered this permission request in Postbox within 2 seconds, so it was denied\./);
    await until(() => cards(p)[0]?.status === 'expired', 'the card to end Expired');
    assert.equal(cards(p)[0].noAnswer, true, 'it says nobody answered in time');
    await heard(m, s.run.pid, 'end');
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
    assert.equal(replyText(p), replyOf('permission-deny'));
    assert.equal(cards(p)[0].status, 'expired', 'still Expired once the turn ended');
    appliedOnce(m, 'one run');
    await until(() => [s.run.pid, s.runner].every(gone), 'the turn’s processes to exit');
  }),
);

test('#120 pipeline: SIGKILL to the runner’s group shows Interrupted, and the turn resumes on its own with CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    /** @type {string[]} */
    const states = [];
    const off = p.store.subscribe(() => {
      const st = p.t && p.rt.sessionsIn(p.t.id)[0]?.remoteTurn?.state;
      if (st && st !== states.at(-1)) states.push(st);
    });
    try {
      const s = await atGate(m, p);
      const shim = (await heard(m, s.run.pid, 'shim')).pid;
      process.kill(-s.runner, 'SIGKILL');
      await until(() => [s.runner, s.run.pid, shim].every(gone), 'the turn’s group to die');
      // No exit.json: the daemon finds the runner gone, and the runtime says Interrupted, then resumes on its own.
      const again = await until(() => standins(m)[1], 'the resumed turn to start on the host', 30_000);
      assert.ok(states.includes('interrupted'), `Interrupted came before the resume (${states.join(', ')})`);
      assert.ok(
        replies(p).some((i) => /^Interrupted on host\.example\.com: /.test(i.error ?? '')),
        'the cut-off reply says Interrupted',
      );
      assert.equal(again.start.resumeInterrupted, '1', 'the resumed turn goes on with the cut-off one');
      assert.ok(again.start.argv.includes('--resume'), 'it resumes the same Claude Code session');
      const resumed = await runnerOf(m, p);
      assert.notEqual(resumed.turn, s.turn, 'a new host turn');
      await heard(m, again.pid, 'end');
      await settled(p);
      assert.equal(p.se().remoteTurn.state, 'done');
      assert.ok(replyText(p).endsWith(replyOf('model-effort')), 'the resumed turn’s reply');
      appliedOnce(m, 'the resumed run');
      assert.equal(sentOf(m, 'start').length, 2, 'the first turn and the resume');
      await until(() => [again.pid, resumed.runner].every(gone), 'the resumed turn’s processes to exit');
    } finally {
      off();
    }
  }),
);

test('#120 pipeline: on Linux, no process with this file’s marker outlives the tests above', {
  skip: LINUX ? false : 'needs /proc to find processes by their environment; on macOS each test checks the PIDs it saw instead',
  timeout: 15_000,
}, async () => {
  await until(() => !marked(RUN).length, 'every marked process to be gone', 5000).catch(() => {});
  assert.deepEqual(marked(RUN), []);
});
