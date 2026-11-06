// A turn’s start on a host without this Postbox’s version, end to end on the laptop (#464-b2b; designs/464-keep-updated.md,
// “What b2b adds”): a real Runtime and the real host manager, over a fake ssh whose attach exits 127 until the install
// has run, and then reaches tests/fake-daemon.mjs. With the consent on, the turn waits for the automatic install and
// starts on the new version, and no failure reaches the thread. Nothing starts a process or opens a connection.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { createHostManager } from '../server/remote/hosts.mjs';
import { installCommand, tokenCommand, tokenFile } from '../server/remote/install.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { until, VERSION } from './remote-hosts-fixtures.mjs';
import { installs, NOT_INSTALLED } from './remote-hosts-update-fixtures.mjs';

const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
const never = () => {
  throw new Error('A remote turn used this computer’s processes.');
};

/**
 * A spawn whose attach exits 127 until an install has run, then reaches the daemon. runs: the install runs.
 * @param {ReturnType<typeof createFakeDaemon>} d
 */
function hostWithoutVersion(d, { hang = false } = {}) {
  const ssh = fakeSsh({ daemon: d });
  const plain = fakeSsh({ script: (/** @type {any} */ child) => child.plan(child) });
  const t = { installed: false, runs: /** @type {any[]} */ ([]), dials: 0 };
  /** @type {import('../server/remote/ssh.mjs').SpawnLike} */
  const spawn = (program, args, options) => {
    const last = args.at(-1);
    const attach = last !== installCommand(VERSION) && last !== tokenCommand(VERSION);
    if (attach) t.dials++;
    if (attach && t.installed) return ssh.spawn(program, args, options);
    const child = /** @type {any} */ (plain.spawn(program, args, options));
    if (attach) child.plan = (/** @type {any} */ c) => c.fail(127, NOT_INSTALLED);
    else if (last === tokenCommand(VERSION)) {
      child.plan = (/** @type {any} */ c) => {
        c.stdout.write(`${FAKE_TOKEN}\n`);
        c.exit(0);
      };
    } else {
      t.runs.push(child);
      child.plan = (/** @type {any} */ c) => {
        if (hang) return;
        t.installed = true;
        installs(c);
      };
    }
    return child;
  };
  return Object.assign(t, { spawn });
}

/**
 * A Postbox with one Claude Code persona placed on a host that has this Postbox’s token but not its version. hang: the
 * install never ends, until Postbox closes.
 */
function postbox({ hang = false } = {}) {
  const d = createFakeDaemon({ autoEnd: false });
  const host = hostWithoutVersion(d, { hang });
  const dataDir = mkdtempSync(join(tmpdir(), 'pbe-auto-'));
  const store = new Store(null);
  const claude = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-remote-never', spawnImpl: never, kill: never, listProcesses: async () => never() });
  /** @type {Runtime} */
  let rt;
  const hosts = createHostManager({ getHost: (id) => rt.s.hosts?.[id] ?? null, dataDir, version: VERSION, spawn: host.spawn, delay: () => 5 });
  rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(claude),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, build: { version: VERSION } },
    hosts,
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const h = rt.addHost({ name: 'host.example.com' });
  mkdirSync(join(dataDir, 'remote-tokens'), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile(dataDir, h.id), `${FAKE_TOKEN}\n`, { mode: 0o600 });
  const p = rt.createPersona({ handle: 'coder', backend: 'claude-code', remote: { hostId: h.id } });
  store.emit('persona', { ...rt.persona(p.id), permissionMode: 'ask' });
  const thread = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const done = async () => {
    await rt.stopTurns({ graceMs: 50 });
    hosts.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { rt, store, d, host, hosts, hostId: h.id, threadId: thread.id, done };
}

test('#464-b2b e2e: a turn on a host without this version, with the consent on, waits for the install and starts there', async () => {
  const p = postbox();
  try {
    await p.hosts.setKeepUpdated(p.hostId, true);
    p.rt.sendMessage(p.threadId, { text: 'hi' });
    const starts = () => p.d.received.filter((m) => m.type === 'start');
    await until(() => starts().length === 1, 'the turn to start on the host', 4000);
    assert.equal(p.host.runs.length, 1, 'one automatic install');
    assert.equal(p.hosts.status(p.hostId).update.outcome, 'installed');
    const failed = p.store.items(p.threadId).filter((i) => i.status === 'failed' || i.error);
    assert.deepEqual(failed, [], 'no failure reached the thread');
  } finally {
    await p.done();
  }
});

test('#464-b2b e2e: Stop ends a turn that waits for the install at once, and the install goes on', async () => {
  const p = postbox({ hang: true });
  try {
    await p.hosts.setKeepUpdated(p.hostId, true);
    p.rt.sendMessage(p.threadId, { text: 'hi' });
    await until(() => p.host.runs.length === 1, 'the automatic install to start', 4000);
    const se = Object.values(p.rt.s.sessions).find((x) => x.threadId === p.threadId);
    await until(() => p.rt.s.sessions[se.id].state !== 'idle', 'the turn to be under way');
    p.rt.stop(se.id);
    await until(() => p.rt.s.sessions[se.id].state === 'idle', 'the turn to end', 1000);
    assert.equal(p.hosts.updating.has(p.hostId), true, 'the install is still running');
    assert.equal(p.d.received.filter((m) => m.type === 'start').length, 0, 'nothing started on the host');
  } finally {
    await p.done();
  }
});
