// Installing on a host, with real sh and tar on this machine (server/remote/install.mjs and the `host` launcher, #120
// L2). sshd hands a remote command to the login shell, so each test runs ssh’s last argument with `/bin/sh -c` and a
// temp folder as HOME, in place of ssh: the install script, the token step through the launcher, and an attach that
// gets a welcome from the installed copy. The launcher’s own tests are in remote-install-launcher.test.mjs, a version
// that’s already there in remote-install-present.test.mjs, and the start lock in remote-install-lock.test.mjs and
// remote-install-break.test.mjs. No network; nothing touches the real home folder.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bundle, describeInstall, installCommand, installHost, readToken } from '../../server/remote/install.mjs';
import { remoteCommand } from '../../server/remote/ssh.mjs';
import { encode, message, PROTOCOL_VERSION } from '../../shared/remote-protocol.mjs';
import { readMessages } from '../fake-daemon.mjs';
import { HOST, installOnce, liveRecord, localShell, machines, modes, SKIP, top, VERSION } from './remote-install-fixtures.mjs';

// ── The install ─────────────────────────────────────────────────────────────────────

test('installHost installs the shipped files 0600 in 0700 folders, checked, and keeps the host’s token on the laptop', { skip: SKIP }, async () => {
  const m = machines();
  try {
    const r = await installHost({ host: HOST, version: VERSION, dataDir: m.data, spawn: localShell(m.env) });
    assert.equal(r.installed, true);
    assert.match(r.token, /^[0-9a-f]{64}$/);
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(root, 'token'), 'utf8'), r.token);
    assert.equal(statSync(join(root, 'token')).mode & 0o777, 0o600);
    assert.equal(await readToken({ dataDir: m.data, hostId: HOST.id }), r.token);
    const b = bundle({ version: VERSION });
    const got = modes(code);
    for (const f of b.files) assert.equal(got[f.path], f.path === 'server/remote/host/host' ? 0o700 : 0o600, f.path);
    for (const [f, mode] of Object.entries(got)) if (statSync(join(code, f)).isDirectory()) assert.equal(mode, 0o700, f);
    assert.deepEqual(
      Object.keys(got)
        .filter((f) => statSync(join(code, f)).isFile())
        .sort(),
      [...b.files.map((f) => f.path), 'manifest.sha256'].sort(),
    );
    assert.ok(!readdirSync(root).some((f) => f.startsWith('.install-')), 'no temporary folder is left');
    for (const f of b.files) assert.deepEqual(readFileSync(join(code, f.path)), f.data, f.path);
    // Again: the version is there, so it’s left alone, and the token is the same.
    const before = statSync(join(code, 'manifest.sha256')).mtimeMs;
    const again = await installHost({ host: HOST, version: VERSION, dataDir: m.data, spawn: localShell(m.env) });
    assert.deepEqual(again, { ...r, installed: false });
    assert.equal(statSync(join(code, 'manifest.sha256')).mtimeMs, before);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('the installed copy runs: attach starts its daemon, which welcomes the token install fetched', { skip: SKIP }, async () => {
  const m = machines();
  /** @type {import('node:child_process').ChildProcess | null} */
  let attach = null;
  try {
    const { token } = await installHost({ host: HOST, version: VERSION, dataDir: m.data, spawn: localShell(m.env) });
    const child = spawn('/bin/sh', ['-c', remoteCommand(VERSION)], { env: m.env, stdio: ['pipe', 'pipe', 'pipe'] });
    attach = child;
    const msgs = readMessages(child.stdout);
    child.stdin.write(encode(message('postbox-to-daemon', 'hello', { version: PROTOCOL_VERSION, token })));
    const welcome = await msgs.next('welcome', 20_000);
    assert.equal(welcome.version, PROTOCOL_VERSION);
    assert.equal(welcome.home, m.home);
  } finally {
    attach?.stdin?.end();
    attach?.kill();
    // The daemon outlives the attach; daemon.pid names it.
    const pidFile = join(m.home, '.postbox-remote', VERSION, 'daemon.pid');
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    try {
      process.kill(JSON.parse(readFileSync(pidFile, 'utf8')).pid, 'SIGTERM');
    } catch {}
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('nodePath ships as node-path, and a reinstall with the setting cleared removes it', { skip: SKIP }, async () => {
  const m = machines();
  try {
    const host = { ...HOST, settings: { ...HOST.settings, nodePath: process.execPath } };
    await installHost({ host, version: VERSION, dataDir: m.data, spawn: localShell(m.env) });
    const file = join(m.home, '.postbox-remote', VERSION, 'node-path');
    assert.equal(readFileSync(file, 'utf8'), `${process.execPath}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(describeInstall(host, { version: VERSION, dataDir: m.data }).text.includes(process.execPath));
    await installHost({ host: HOST, version: VERSION, dataDir: m.data, spawn: localShell(m.env) });
    assert.ok(!existsSync(file));
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a file that changed on the way fails the SHA-256 check, and nothing is installed', { skip: SKIP }, () => {
  const m = machines();
  try {
    const { tar, files } = bundle({ version: VERSION });
    // A byte of the first file’s data, just past its header: still a valid tar, now with a wrong file.
    const bad = Buffer.from(tar);
    bad[512] ^= 0x01;
    const r = spawnSync('/bin/sh', ['-c', installCommand(VERSION)], { input: bad, env: m.env, encoding: 'utf8' });
    assert.equal(r.status, 66, r.stderr);
    assert.ok(r.stderr.includes(files[0].path), r.stderr);
    assert.match(r.stderr, /postbox install: checksums did not match/);
    assert.deepEqual(readdirSync(join(m.home, '.postbox-remote')), [], 'neither the version nor a temporary folder');
    const cut = spawnSync('/bin/sh', ['-c', installCommand(VERSION)], { input: tar.subarray(0, 700), env: m.env, encoding: 'utf8' });
    assert.notEqual(cut.status, 0, 'a cut-off tar fails');
    assert.deepEqual(readdirSync(join(m.home, '.postbox-remote')), []);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a version folder that isn’t a complete install is replaced, unless its daemon is live', { skip: SKIP }, () => {
  const m = machines();
  try {
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, 'daemon.log'), 'kept');
    writeFileSync(join(code, 'daemon.pid'), liveRecord());
    const { tar } = bundle({ version: VERSION });
    const r = installOnce(m, tar);
    assert.equal(r.status, 75, r.stderr);
    assert.deepEqual(readdirSync(code).sort(), ['daemon.log', 'daemon.pid']);
    assert.deepEqual(top(root), [VERSION, 'locks'], 'no temporary folder is left');
    rmSync(join(code, 'daemon.pid'));
    const ok = installOnce(m, tar);
    assert.equal(ok.stdout, `installed ${VERSION}\n`, ok.stderr);
    assert.match(ok.stderr, /postbox install: replacing .*, whose files are not these/);
    assert.ok(!existsSync(join(code, 'daemon.log')));
    assert.deepEqual(top(root), [VERSION, 'locks']);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('without sha256sum or shasum, the files are checked with node', { skip: SKIP }, () => {
  const m = machines();
  try {
    // A PATH with only what the script needs besides a checksum tool.
    const bin = join(m.root, 'bin');
    mkdirSync(bin);
    for (const tool of ['tar', 'mkdir', 'rmdir', 'chmod', 'rm', 'mv', 'cat', 'grep', 'sed', 'find']) {
      const found = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      symlinkSync(found, join(bin, tool));
    }
    symlinkSync(process.execPath, join(bin, 'node'));
    const env = { HOME: m.home, PATH: bin };
    const { tar } = bundle({ version: VERSION });
    const ok = spawnSync('/bin/sh', ['-c', installCommand(VERSION)], { input: tar, env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, `installed ${VERSION}\n`);
    // node checks the installed copy too: the same files are present, and a changed one is replaced.
    assert.equal(spawnSync('/bin/sh', ['-c', installCommand(VERSION)], { input: tar, env, encoding: 'utf8' }).stdout, `present ${VERSION}\n`);
    const changed = join(m.home, '.postbox-remote', VERSION, 'package.json');
    writeFileSync(changed, '{}\n');
    assert.equal(spawnSync('/bin/sh', ['-c', installCommand(VERSION)], { input: tar, env, encoding: 'utf8' }).stdout, `installed ${VERSION}\n`);
    assert.notEqual(readFileSync(changed, 'utf8'), '{}\n');
    rmSync(join(m.home, '.postbox-remote', VERSION), { recursive: true });
    const bad = Buffer.from(tar);
    bad[512] ^= 0x01;
    const r = spawnSync('/bin/sh', ['-c', installCommand(VERSION)], { input: bad, env, encoding: 'utf8' });
    assert.equal(r.status, 66, r.stderr);
    assert.match(r.stderr, /: FAILED/);
    // And with no node either, it says it can’t check.
    rmSync(join(bin, 'node'));
    const none = spawnSync('/bin/sh', ['-c', installCommand(VERSION)], { input: tar, env, encoding: 'utf8' });
    assert.equal(none.status, 69, none.stderr);
    chmodSync(bin, 0o755);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a symbolic link for ~/.postbox-remote or the version’s folder is refused, and nothing is written through it', { skip: SKIP }, () => {
  const m = machines();
  try {
    const { tar } = bundle({ version: VERSION });
    const elsewhere = join(m.root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o755 });
    const root = join(m.home, '.postbox-remote');
    symlinkSync(elsewhere, root);
    const r = installOnce(m, tar);
    assert.equal(r.status, 77, r.stderr);
    assert.match(r.stderr, /is a symbolic link/);
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.equal(statSync(elsewhere).mode & 0o777, 0o755, 'its mode is left as it was');
    rmSync(root);
    mkdirSync(root, { mode: 0o700 });
    symlinkSync(elsewhere, join(root, VERSION));
    const v = installOnce(m, tar);
    assert.equal(v.status, 77, v.stderr);
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.deepEqual(readdirSync(root), [VERSION], 'no temporary folder is left');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});
