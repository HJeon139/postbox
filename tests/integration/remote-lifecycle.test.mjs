// The life of Postbox’s host program on a host (#120, the researcher’s G2: the issue’s last “Done when” items), for
// real, with only ssh replaced. Each “ssh” runs its remote command on this machine with /bin/sh -c, as sshd hands it
// to the login shell, with a temp folder as HOME: the install script (`/bin/sh -c '<script>' postbox-install
// <version>`, as installHost builds it) unpacks the real bundle, the ustar and its manifest, there; `host token` makes
// the token; and every attach runs the installed copy’s launcher, `~/.postbox-remote/<version>/server/remote/host/host
// attach`, which starts the installed daemon, and the daemon its runners. The harness is a stand-in written to the temp
// folder, as a CLI installed on the host would be, started as claudePath; it can start the installed shim, as Claude
// Code starts its MCP servers. Covered here: the install and a first welcome, and the idle exit, after which nothing
// of Postbox’s runs on the host. Remove from the runtime with a turn running, and no TCP listener on either machine
// during a turn, are in remote-lifecycle-remove.test.mjs. The processes talk over pipes and Unix sockets only, and the
// tests open no TCP port.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { bundle, installCommand, ROOT, TOKEN_RE, tokenCommand, tokenFile } from '../../server/remote/install.mjs';
import { remoteCommand } from '../../server/remote/ssh.mjs';
import { REMOTE_DIR } from '../../shared/remote-protocol.mjs';
import { gone, sleep } from './host.mjs';
import {
  commandOf,
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

/** @param {Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

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

// The real daemon’s idle time, shortened from idleTimeout’s minute-long floor by POSTBOX_DAEMON_TIMINGS (for tests only;
// it can only shorten it), so this test takes seconds, not a minute. tests/remote-daemon-host.test.mjs covers the
// setting itself on a fake clock.
const IDLE = 4000;

test('idle exit (G2): with a short idle time, the daemon exits once the last client has gone and no turn runs, and nothing of Postbox’s is left running', {
  skip: SKIP,
  timeout: IDLE + 60_000,
}, async () => {
  const m = machines({ env: { POSTBOX_DAEMON_TIMINGS: JSON.stringify({ idleTimeout: IDLE }) } });
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
    await sleep(IDLE / 4);
    assert.equal(gone(daemon), false, 'the daemon waits out its idle time');
    await waitFor(() => gone(daemon), 'the daemon to exit on its own', IDLE + 30_000, 250);
    const after = Date.now() - left;
    assert.ok(after >= IDLE - 2000, `it exited ${after} ms after the last client left, not before its idle time (${IDLE} ms)`);

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
