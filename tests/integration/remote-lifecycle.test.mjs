// The life of Postbox’s host program on a host (#120, the researcher’s G2: the issue’s last “Done when” items), for
// real, with only ssh replaced. Each “ssh” runs its remote command on this machine with /bin/sh -c, as sshd hands it
// to the login shell, with a temp folder as HOME: the install script (`/bin/sh -c '<script>' postbox-install
// <version>`, as installHost builds it) unpacks the real bundle, the ustar and its manifest, there; `host token` makes
// the token; and every attach runs the installed copy’s launcher, `~/.postbox-remote/<version>/server/remote/host/host
// attach`, which starts the installed daemon, and the daemon its runners. The harness is a stand-in written to the temp
// folder, as a CLI installed on the host would be, started as claudePath; it can start the installed shim, as Claude
// Code starts its MCP servers. Covered: the install and a first welcome; the idle exit, after which nothing of
// Postbox’s runs on the host; Remove from the runtime with a turn running; and no TCP listener on either machine
// during a turn. The processes talk over pipes and Unix sockets only, and the test opens no TCP port: the listener
// check’s parsing is unit-tested on recorded output in tests/listeners.test.mjs.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../../server/adapters/adapter.mjs';
import { createHostManager } from '../../server/remote/hosts.mjs';
import { bundle, installCommand, installHost, ROOT, TOKEN_RE, tokenCommand, tokenFile } from '../../server/remote/install.mjs';
import { createSshConnection, remoteCommand } from '../../server/remote/ssh.mjs';
import { Runtime } from '../../server/runtime.mjs';
import { Store } from '../../server/store.mjs';
import { hostPaths, message, REMOTE_DIR } from '../../shared/remote-protocol.mjs';
import { defaultHostSettings, RANGES } from '../../shared/remote-settings.mjs';
import { gone, sleep } from './host.mjs';
import { NO_LISTENERS, tcpListeners } from './listeners.mjs';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const DEST = 'host.example.com';
const IDLE_MIN = RANGES.idleTimeout.min;
const SKIP = process.platform !== 'linux' && process.platform !== 'darwin' && 'needs a POSIX sh, tar, Unix sockets and process groups';

/**
 * The stand-in harness: prints `harness:<pid>`; given the shim’s path (not “-”), starts it as `node shim.mjs <turn>`,
 * says initialize, and prints `shim:<pid>` once it answers; then waits `ms`. SIGINT ends it, and the shim, by Node’s
 * default, as it ends a Claude Code turn.
 */
const HARNESS = `import { spawn } from 'node:child_process';
const [shim, turn, ms] = process.argv.slice(2);
process.stdout.write('harness:' + process.pid + '\\n');
if (shim !== '-') {
  const s = spawn(process.execPath, [shim, turn], { stdio: ['pipe', 'pipe', 'inherit'] });
  s.stdout.once('data', () => process.stdout.write('shim:' + s.pid + '\\n'));
  const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stand-in', version: '0' } };
  s.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init }) + '\\n');
}
setTimeout(() => {}, Number(ms));
`;

/**
 * A host home and a laptop data folder under one temp folder in /tmp (short enough for the sockets’ paths), the
 * harness beside them, and the host’s settings: the harness’s node as claudePath, and the shortest idleTimeout.
 */
function machines() {
  const root = mkdtempSync('/tmp/pbv-');
  const home = join(root, 'h');
  mkdirSync(home);
  const harness = join(root, 'harness.mjs');
  writeFileSync(harness, HARNESS, { mode: 0o600 });
  const settings = { ...defaultHostSettings(), claudePath: process.execPath, idleTimeout: IDLE_MIN };
  return {
    root,
    // macOS’s /tmp is a link to /private/tmp, and node resolves its main module’s path, so a command line may say either.
    roots: [...new Set([root, realpathSync(root)])],
    home,
    data: join(root, 'data'),
    harness,
    p: hostPaths(home, VERSION),
    host: { id: 'ho_life0001', name: DEST, settings },
    settings,
    env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  };
}
/** @typedef {ReturnType<typeof machines>} Machines */

/**
 * ssh, replaced: each run checks that it’s one Postbox makes (options, `--`, the destination, then one of its three
 * remote commands), then runs that command with /bin/sh -c in the host’s environment.
 * @param {Machines} m
 */
function sshHere(m) {
  /** @type {{ args: string[], child: import('node:child_process').ChildProcess }[]} */
  const calls = [];
  const known = [installCommand(VERSION), tokenCommand(VERSION), remoteCommand(VERSION)];
  /** @type {any} */
  const run = (/** @type {string} */ program, /** @type {string[]} */ args, /** @type {object} */ options) => {
    const command = args.at(-1) ?? '';
    if (program !== 'ssh' || args[0] !== '-o' || args.at(-3) !== '--' || args.at(-2) !== DEST || !known.includes(command))
      throw new Error(`That isn’t an ssh run Postbox makes: ${program} ${args.join(' ').slice(0, 200)}`);
    const child = spawn('/bin/sh', ['-c', command], { ...options, env: m.env });
    calls.push({ args, child });
    return child;
  };
  /** The attaches still running, by their PIDs. */
  const attaches = () => calls.filter((c) => c.args.at(-1) === remoteCommand(VERSION) && c.child.exitCode === null && c.child.signalCode === null);
  return { spawn: run, calls, attaches };
}

/** Every message an emitter (a connection or a link) gives, and a wait for one. @param {import('node:events').EventEmitter} source */
function inbox(source) {
  /** @type {any[]} */
  const all = [];
  source.on('message', (m) => all.push(m));
  return {
    all,
    /** The first message of a type that passes `pick`, within ms. */
    got: (/** @type {string} */ type, pick = (/** @type {any} */ _m) => true, ms = 15_000) =>
      waitFor(() => all.find((m) => m.type === type && pick(m)), `a ${type}`, ms),
    /** The PID a `<name>:<pid>` line of the harness’s gave. */
    pid: async (/** @type {string} */ name, ms = 15_000) => {
      const line = await waitFor(() => all.find((m) => m.type === 'line' && m.text.startsWith(`${name}:`)), `the ${name}’s PID`, ms);
      return Number(line.text.slice(name.length + 1));
    },
  };
}

/** check()’s first truthy value, looked at every `every` ms, within ms. */
async function waitFor(check, what, ms, every = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for ${what}.`);
    await sleep(every);
  }
}

/** A turn’s start for the stand-in harness, in a folder the daemon makes under ~/postbox-work. @param {Machines} m */
const startBody = (m, turn, shim, ms) => ({
  turn,
  harness: 'claude-code',
  folder: `${m.home}/postbox-work/life`,
  argv: [m.harness, shim, turn, String(ms)],
  env: {},
  stdin: 'none',
  files: [],
});

/** @param {Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The PID in a record file (daemon.pid, runner.json). @param {string} path */
const pidIn = (path) => JSON.parse(readFileSync(path, 'utf8')).pid;

/**
 * Every process on this machine whose command line contains one of the strings: ps, else (a Linux image without
 * procps) /proc. A zombie no one has reaped has no command line, so it isn’t one.
 * @param {string[]} needles @returns {{ pid: number, command: string }[]}
 */
function processesWith(needles) {
  let rows;
  try {
    rows = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
      .filter((x) => x !== null)
      .map((x) => ({ pid: Number(x[1]), command: x[2] }));
  } catch (e) {
    if (process.platform !== 'linux' || e.code !== 'ENOENT') throw e;
    rows = [];
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        rows.push({ pid: Number(d), command: readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ').trim() });
      } catch {}
    }
  }
  return rows.filter((r) => r.pid !== process.pid && needles.some((n) => r.command.includes(n)));
}
/** Postbox’s processes on the host: those running something under the temp home’s ~/.postbox-remote. @param {Machines} m */
const postboxOnHost = (m) => processesWith(m.roots.map((r) => `${r}/h/${REMOTE_DIR}/`));
/**
 * The relays: each attach’s node, running the installed host.mjs. The ssh stand-in’s own child may be the login shell
 * that started it (dash doesn’t exec a -c command’s last program; bash does), so they’re found by command line.
 * @param {Machines} m
 */
const relays = (m) => postboxOnHost(m).filter((r) => r.command.endsWith('/server/remote/host/host.mjs attach'));
/** One process’s command line, or null once it’s gone. @param {Machines} m @param {number} pid */
const commandOf = (m, pid) => processesWith(m.roots).find((r) => r.pid === pid)?.command ?? null;

/**
 * Ends everything the test started (the ssh stand-ins, and any process whose command line names the temp folder:
 * daemons, runners, harnesses and shims) and removes the temp folder.
 * @param {Machines} m @param {ReturnType<typeof sshHere>} [ssh]
 */
async function reap(m, ssh) {
  for (const c of ssh?.calls ?? []) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
  for (let i = 0; i < 3; i++) {
    const left = processesWith(m.roots);
    if (!left.length) break;
    for (const r of left) {
      try {
        process.kill(r.pid, 'SIGKILL');
      } catch {}
    }
    await sleep(100);
  }
  rmSync(m.root, { recursive: true, force: true });
}

/** Installs, connects and has the welcome. @param {Machines} m @param {ReturnType<typeof sshHere>} ssh */
async function installAndAttach(m, ssh) {
  const installed = await installHost({ host: m.host, version: VERSION, dataDir: m.data, spawn: ssh.spawn });
  const conn = createSshConnection({ destination: DEST, settings: m.settings, version: VERSION, token: installed.token, spawn: ssh.spawn });
  const box = inbox(conn);
  const closed = new Promise((resolve) => conn.once('close', resolve));
  const welcome = await conn.connect();
  return { installed, conn, box, welcome, closed };
}

// ── The tests ───────────────────────────────────────────────────────────────────────

test('install: the real bundle lands in the host’s home, the token comes back 0600 here, and an attach runs the installed copy', {
  skip: SKIP,
  timeout: 60_000,
}, async () => {
  const m = machines();
  const ssh = sshHere(m);
  /** @type {Awaited<ReturnType<typeof installAndAttach>> | null} */
  let a = null;
  try {
    a = await installAndAttach(m, ssh);
    const { installed, welcome } = a;
    assert.equal(installed.installed, true);
    assert.equal(installed.version, VERSION);
    assert.match(installed.token, TOKEN_RE);
    assert.deepEqual(
      ssh.calls.map((c) => c.args.at(-1)),
      [installCommand(VERSION), tokenCommand(VERSION), remoteCommand(VERSION)],
      'three ssh runs: the install script, the token, then the attach',
    );

    // The host: the bundle’s manifest, byte for byte, and every file it names, by its SHA-256.
    const b = bundle({ version: VERSION });
    const manifest = readFileSync(join(m.p.code, 'manifest.sha256'), 'utf8');
    assert.equal(manifest, b.manifest, 'the installed manifest is the bundle’s');
    const lines = manifest.trimEnd().split('\n');
    assert.equal(lines.length, b.files.length);
    for (const line of lines) {
      const [hash, path] = [line.slice(0, 64), line.slice(66)];
      assert.equal(sha256(readFileSync(join(m.p.code, path))), hash, path);
    }
    assert.equal(statSync(m.p.root).mode & 0o777, 0o700);
    assert.equal(readFileSync(m.p.token, 'utf8'), installed.token, 'the host’s token is the one that came back');
    assert.equal(statSync(m.p.token).mode & 0o777, 0o600);

    // The laptop: the token in its own file, 0600 in a 0700 folder, under the data folder.
    const file = tokenFile(m.data, m.host.id);
    assert.equal(file, join(m.data, 'remote-tokens', m.host.id));
    assert.equal(readFileSync(file, 'utf8'), `${installed.token}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);

    // The attach: a welcome for that token, from a daemon and a relay running the installed code, not this checkout’s.
    assert.equal(welcome.home, m.home);
    assert.ok(Array.isArray(welcome.turns) && welcome.turns.length === 0);
    const daemon = pidIn(join(m.p.code, 'daemon.pid'));
    const entry = (r) => `${r}/h/${REMOTE_DIR}/${VERSION}/server/remote/host/host.mjs`;
    const serving = commandOf(m, daemon);
    assert.ok(serving && m.roots.some((r) => serving.includes(`${entry(r)} serve`)), `the daemon runs the installed host.mjs: ${serving}`);
    const found = relays(m);
    assert.equal(found.length, 1, 'one relay, for the one attach');
    const relaying = found[0].command;
    assert.ok(relaying && m.roots.some((r) => relaying.includes(`${entry(r)} attach`)), `the relay runs the installed host.mjs: ${relaying}`);
    for (const c of [serving, relaying]) assert.ok(!c?.includes(join(ROOT, 'server')), `nothing runs from the checkout: ${c}`);
  } finally {
    a?.conn.close();
    await reap(m, ssh);
  }
});

test('idle exit (G2): with idleTimeout at its minimum, the daemon exits once the last client has gone and no turn runs, and nothing of Postbox’s is left running', {
  skip: SKIP,
  timeout: IDLE_MIN + 60_000,
}, async () => {
  const m = machines();
  const ssh = sshHere(m);
  /** @type {Awaited<ReturnType<typeof installAndAttach>> | null} */
  let a = null;
  try {
    a = await installAndAttach(m, ssh);
    const { conn, box } = a;
    // One turn that runs and ends while Postbox is attached, so a runner has come and gone too.
    conn.send({ type: 'start', ...startBody(m, 't1', '-', 0) });
    await box.got('started', (x) => x.turn === 't1');
    conn.send({ type: 'read', turn: 't1', from: 0 });
    const ended = await box.got('ended', (x) => x.turn === 't1');
    assert.equal(ended.exit?.code, 0);
    const harness = await box.pid('harness');
    const runner = pidIn(m.p.turn('t1', 'runner.json'));
    const daemon = pidIn(join(m.p.code, 'daemon.pid'));
    assert.equal(gone(daemon), false, 'the daemon is up while Postbox is attached');

    conn.close();
    await a.closed;
    const left = Date.now();
    await waitFor(() => ssh.attaches().length === 0 && relays(m).length === 0, 'the relay to exit', 10_000);
    await sleep(Math.min(5000, IDLE_MIN / 4));
    assert.equal(gone(daemon), false, 'the daemon waits out its idle time');
    await waitFor(() => gone(daemon), 'the daemon to exit on its own', IDLE_MIN + 30_000, 250);
    const after = Date.now() - left;
    assert.ok(after >= IDLE_MIN - 2000, `it exited ${after} ms after the last client left, not before idleTimeout (${IDLE_MIN} ms)`);

    for (const pid of [harness, runner]) assert.equal(gone(pid), true, `process ${pid} is gone`);
    assert.deepEqual(postboxOnHost(m), [], 'no process runs anything under the host’s ~/.postbox-remote');
    assert.equal(existsSync(m.p.socket), false, 'the daemon removed its socket');
    assert.equal(existsSync(join(m.p.code, 'daemon.pid')), false, 'and let go of daemon.pid');
    assert.equal(existsSync(m.p.code), true, 'an idle exit leaves the install as it is');
  } finally {
    a?.conn.close();
    await reap(m, ssh);
  }
});

test('remove (G2): with a turn running, Runtime.removeHost stops it, the daemon deletes ~/.postbox-remote and says removed, and only then the token and the host go here', {
  skip: SKIP,
  timeout: 60_000,
}, async () => {
  const m = machines();
  const ssh = sshHere(m);
  writeFileSync(join(m.home, 'keep.txt'), 'mine');
  /** @type {Runtime | null} */
  let rt = null;
  const mgr = createHostManager({ getHost: (id) => rt?.s.hosts?.[id] ?? null, dataDir: m.data, version: VERSION, spawn: ssh.spawn });
  rt = new Runtime({
    store: new Store(null),
    adapters: new AdapterRegistry().register({ name: 'mock', deliver: async () => {} }),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], home: '/nowhere', build: { version: VERSION } },
    hosts: mgr,
  });
  const r = rt;
  try {
    const host = r.addHost({ name: DEST, settings: { claudePath: process.execPath, idleTimeout: IDLE_MIN } });
    assert.deepEqual(await r.installHost(host.id), { ok: true, installed: true, version: VERSION });
    const token = tokenFile(m.data, host.id);
    assert.equal(existsSync(token), true);

    // A turn started over the runtime’s own link, which the daemon’s remove has to stop.
    const link = mgr.link(host.id);
    const box = inbox(link);
    await mgr.ensureWelcome(host.id);
    assert.equal(link.send(message('postbox-to-daemon', 'start', startBody(m, 't1', '-', 60_000))), true);
    await box.got('started', (x) => x.turn === 't1');
    assert.equal(link.send(message('postbox-to-daemon', 'read', { turn: 't1', from: 0 })), true);
    const harness = await box.pid('harness');
    const runner = pidIn(m.p.turn('t1', 'runner.json'));
    const daemon = pidIn(join(m.p.code, 'daemon.pid'));
    assert.deepEqual([gone(harness), gone(runner)], [false, false], 'the turn runs');

    /** @type {{ root: boolean, token: boolean, host: boolean, harness: boolean, runner: boolean } | null} */
    let atRemoved = null;
    link.on('message', (x) => {
      if (x.type === 'removed')
        atRemoved = { root: existsSync(m.p.root), token: existsSync(token), host: Boolean(r.s.hosts?.[host.id]), harness: gone(harness), runner: gone(runner) };
    });
    assert.deepEqual(await r.removeHost(host.id), { ok: true, stopped: 0 }, 'no session of the runtime’s had the turn; the daemon stopped it');
    assert.deepEqual(
      atRemoved,
      { root: false, token: true, host: true, harness: true, runner: true },
      'removed came with the turn stopped and ~/.postbox-remote gone there, and the token and the host still here',
    );
    assert.equal(existsSync(m.p.root), false, 'no ~/.postbox-remote on the host');
    assert.equal(readFileSync(join(m.home, 'keep.txt'), 'utf8'), 'mine', 'nothing else in the home folder changed');
    assert.equal(existsSync(token), false, 'then the token here went');
    assert.equal(r.s.hosts?.[host.id], undefined, 'and the host');
    await waitFor(() => gone(daemon), 'the daemon to exit', 10_000);
    await waitFor(() => ssh.attaches().length === 0 && relays(m).length === 0, 'the relay to exit', 10_000);
    assert.deepEqual(postboxOnHost(m), [], 'nothing of Postbox’s runs on the host');
  } finally {
    mgr.close();
    await reap(m, ssh);
  }
});

test('no TCP listener (G2): during a turn, ssh’s stand-in, the relay, daemon, runner, harness and shim, and the laptop’s side, listen on no TCP port; the sockets are Unix ones, 0600 in 0700 folders', {
  skip: SKIP || NO_LISTENERS,
  timeout: 60_000,
}, async () => {
  const m = machines();
  const ssh = sshHere(m);
  /** @type {Awaited<ReturnType<typeof installAndAttach>> | null} */
  let a = null;
  try {
    a = await installAndAttach(m, ssh);
    const { conn, box } = a;
    const shim = join(m.p.code, 'server', 'remote', 'host', 'shim.mjs');
    conn.send({ type: 'start', ...startBody(m, 't1', shim, 60_000) });
    await box.got('started', (x) => x.turn === 't1');
    conn.send({ type: 'read', turn: 't1', from: 0 });
    const pids = {
      laptop: process.pid,
      relay: relays(m)[0]?.pid ?? 0,
      ssh: /** @type {number} */ (ssh.attaches()[0]?.child.pid),
      daemon: pidIn(join(m.p.code, 'daemon.pid')),
      runner: pidIn(m.p.turn('t1', 'runner.json')),
      harness: await box.pid('harness'),
      shim: await box.pid('shim'),
    };
    for (const [name, pid] of Object.entries(pids)) assert.ok(pid > 1 && !gone(pid), `the ${name} runs (${pid})`);
    assert.ok(commandOf(m, pids.shim)?.includes('/shim.mjs t1'), 'the installed shim is the harness’s MCP server');

    // That the check finds a listener when there is one is tests/listeners.test.mjs’s, on recorded output.
    assert.deepEqual(tcpListeners(Object.values(pids)), [], 'no TCP listener in any of them');

    // The daemon’s socket and the runner’s: Unix sockets, 0600, each in a 0700 folder under a 0700 ~/.postbox-remote.
    for (const sock of [m.p.socket, m.p.turn('t1', 'sock')]) {
      const st = lstatSync(sock);
      assert.ok(st.isSocket(), `${sock} is a Unix socket`);
      assert.equal(st.mode & 0o777, 0o600, sock);
      assert.equal(statSync(dirname(sock)).mode & 0o777, 0o700, dirname(sock));
    }
    for (const dir of [m.p.root, m.p.turns]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);

    conn.send({ type: 'stop', turn: 't1' });
    const ended = await box.got('ended', (x) => x.turn === 't1');
    assert.equal(ended.exit?.signal, 'SIGINT');
    await waitFor(() => gone(pids.shim), 'the shim to go with its turn', 10_000);
  } finally {
    a?.conn.close();
    await reap(m, ssh);
  }
});
