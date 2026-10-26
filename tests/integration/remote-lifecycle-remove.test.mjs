// Remove and listeners in the life of Postbox’s host program on a host (#120, G2), for real, with only ssh replaced,
// as tests/integration/remote-lifecycle.test.mjs sets it up: Remove from the runtime with a turn running, and no TCP
// listener on either machine during a turn. The listener check’s parsing is unit-tested on recorded output in
// tests/listeners.test.mjs.

import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../../server/adapters/adapter.mjs';
import { createHostManager } from '../../server/remote/hosts.mjs';
import { tokenFile } from '../../server/remote/install.mjs';
import { Runtime } from '../../server/runtime.mjs';
import { Store } from '../../server/store.mjs';
import { message } from '../../shared/remote-protocol.mjs';
import { gone } from './host.mjs';
import { NO_LISTENERS, tcpListeners } from './listeners.mjs';
import {
  commandOf,
  DEST,
  IDLE_MIN,
  inbox,
  installAndAttach,
  machines,
  pidIn,
  postboxOnHost,
  reap,
  relays,
  SKIP,
  sshHere,
  startBody,
  VERSION,
  waitFor,
} from './remote-lifecycle-fixtures.mjs';

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
