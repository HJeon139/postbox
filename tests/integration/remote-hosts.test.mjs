// The sign-in check (#120, G5), for real: the host manager (server/remote/hosts.mjs) over its link, with ssh replaced
// by a spawn that connects each session straight to an in-process daemon (server/remote/host/daemon.mjs) in a temp
// POSTBOX_REMOTE_HOME (tests/integration/host.mjs). The daemon runs the host’s signInCheck with the real spawn: `true`
// and `false` from PATH, and node checking that its arguments arrived as given, which a shell would have split.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { hostVersion } from '../../server/remote/host/paths.mjs';
import { createHostManager } from '../../server/remote/hosts.mjs';
import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { makeHost, NO_UNIX, realDaemon, TOKEN } from './host.mjs';

/** A spawn for the links: each “ssh” is a connection to the in-process daemon, as `host attach` relays one. */
function sshToDaemon(daemon) {
  const calls = [];
  const spawn = (program, args) => {
    calls.push({ program, args });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), exitCode: null });
    let closed = false;
    const exit = (code, signal = null) => {
      if (closed) return;
      closed = true;
      if (!stdin.writableEnded) stdin.end();
      if (!stdout.writableEnded) stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    child.kill = (signal = 'SIGTERM') => {
      exit(null, signal);
      return true;
    };
    stdout.on('end', () => exit(0));
    daemon.connect({ input: stdin, output: stdout });
    return child;
  };
  return { spawn, calls };
}

/** A manager whose one host, h1, has the daemon’s token, and the signInCheck given. */
function managerFor(d, signInCheck) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pbh-'));
  mkdirSync(join(dataDir, 'remote-tokens'), { mode: 0o700 });
  writeFileSync(join(dataDir, 'remote-tokens', 'h1'), `${TOKEN}\n`, { mode: 0o600 });
  const host = { id: 'h1', name: 'host.example.com', settings: { ...defaultHostSettings(), signInCheck }, createdAt: 1 };
  const ssh = sshToDaemon(d.daemon);
  const mgr = createHostManager({ getHost: (id) => (id === 'h1' ? host : null), dataDir, version: hostVersion(), spawn: ssh.spawn });
  const done = () => {
    mgr.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { mgr, host, ssh, done };
}

test('sign-in check: the daemon runs the host’s signInCheck from PATH; true passes, false fails with its code', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const d = realDaemon(h);
  const m = managerFor(d, ['true']);
  try {
    await d.daemon.start();
    const passed = await m.mgr.signInCheck('h1');
    assert.equal(passed?.ok, true);
    assert.equal(passed?.code, 0);
    assert.ok(Math.abs((passed?.at ?? 0) - Date.now()) < 10_000, 'at is when it ended on the host');
    m.host.settings = { ...m.host.settings, signInCheck: ['false'] };
    const failed = await m.mgr.signInCheck('h1');
    assert.deepEqual([failed?.ok, failed?.code], [false, 1]);
    assert.equal(m.ssh.calls.length, 2, 'the changed check went in a new session’s hello');
    m.host.settings = { ...m.host.settings, signInCheck: ['/nonexistent/postbox-check'] };
    const missing = await m.mgr.signInCheck('h1');
    assert.deepEqual([missing?.ok, missing?.code], [false, null], 'a check that can’t start fails');
  } finally {
    m.done();
    d.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test('sign-in check: its arguments reach the program as given, with no shell to split or expand them', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const d = realDaemon(h);
  const odd = 'a b; exit 7 $HOME `id` "q"';
  // Exits 0 only if it got exactly one argument, unchanged: a shell would split it at the spaces and the ;.
  const argv = [process.execPath, '-e', 'process.exit(process.argv.length === 2 && process.argv[1] === process.env.X ? 0 : 3)', odd];
  const m = managerFor(d, argv);
  const before = process.env.X;
  process.env.X = odd; // the daemon’s environment, which the check inherits
  try {
    await d.daemon.start();
    const r = await m.mgr.signInCheck('h1');
    assert.deepEqual([r?.ok, r?.code], [true, 0]);
  } finally {
    if (before === undefined) delete process.env.X;
    else process.env.X = before;
    m.done();
    d.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});
