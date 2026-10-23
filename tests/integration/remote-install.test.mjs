// Installing on a host, with real sh and tar on this machine (server/remote/install.mjs and the `host` launcher, #120
// L2). sshd hands a remote command to the login shell, so each test runs ssh’s last argument with `/bin/sh -c` and a
// temp folder as HOME, in place of ssh: the install script, the token step through the launcher, and an attach that
// gets a welcome from the installed copy. The launcher’s own tests use fake nodes, small sh scripts that print a
// version and their arguments. No network; nothing touches the real home folder.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../../server/remote/host/daemon.mjs';
import { hostVersion } from '../../server/remote/host/paths.mjs';
import { bootId, lockOwnerLive, parseLockOwner, startTime } from '../../server/remote/host/proc.mjs';
import { bundle, describeInstall, installCommand, installHost, readToken } from '../../server/remote/install.mjs';
import { remoteCommand } from '../../server/remote/ssh.mjs';
import { encode, hostPaths, message, PROTOCOL_VERSION, validateMessage } from '../../shared/remote-protocol.mjs';
import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { readMessages } from '../fake-daemon.mjs';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'remote', 'host', 'host');
// This checkout’s version, which the daemon’s main() takes from package.json (paths.mjs), so the tests follow each release.
const VERSION = hostVersion();
/** VERSION as a regular expression matches it. */
const V = VERSION.replaceAll('.', '\\.');
const NODE_DIR = dirname(process.execPath);
const HOST = { id: 'ho_test0001', name: 'host.example.com', settings: defaultHostSettings() };
const SKIP = process.platform === 'win32' && 'needs a POSIX sh and tar';

/** A temp folder under /tmp, short enough for the daemon’s socket path. */
const temp = (prefix) => mkdtempSync(`/tmp/${prefix}`);

/** A fake node at `path`: `--version` prints `v<version>`; anything else prints “ran <version>:” and its arguments, one per line. */
function fakeNode(path, version) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\necho "ran ${version}:"\nfor a in "$@"; do echo "$a"; done\n`, {
    mode: 0o755,
  });
  return path;
}

/** A launcher in a version’s folder of its own: <root>/<version>/server/remote/host/host. */
function launcherIn(root) {
  const code = join(root, VERSION);
  const host = join(code, 'server', 'remote', 'host', 'host');
  mkdirSync(dirname(host), { recursive: true });
  writeFileSync(host, readFileSync(LAUNCHER), { mode: 0o700 });
  return { code, host };
}

/** Runs the launcher with sh, as the login shell would: `env` replaces the environment entirely. */
function launch(host, args, env) {
  const r = spawnSync('/bin/sh', [host, ...args], { env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Whether a real node 22 or later is at one of the launcher’s system paths, which a “none found” test can’t hide. */
const systemNode = ['/usr/local/bin/node', '/usr/bin/node'].find((p) => {
  try {
    return Number(/^v(\d+)/.exec(execFileSync(p, ['--version'], { encoding: 'utf8' }))?.[1]) >= 22;
  } catch {
    return false;
  }
});

// ── The launcher ────────────────────────────────────────────────────────────────────

test('the launcher runs host.mjs with node-path’s node first, passing the arguments unchanged', { skip: SKIP }, () => {
  const root = temp('pbl-');
  try {
    const home = join(root, 'home');
    const { code, host } = launcherIn(root);
    const configured = fakeNode(join(root, 'opt', 'node'), '22.4.0');
    fakeNode(join(root, 'bin', 'node'), '24.0.0');
    writeFileSync(join(code, 'node-path'), `${configured}\n`);
    const r = launch(host, ['attach', 'two words', '$(id)', ''], { HOME: home, PATH: `${join(root, 'bin')}:/usr/bin:/bin` });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `ran 22.4.0:\n${join(code, 'server', 'remote', 'host', 'host.mjs')}\nattach\ntwo words\n$(id)\n\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the launcher takes PATH’s node next, and passes over a node-path that’s too old or missing', { skip: SKIP }, () => {
  const root = temp('pbl-');
  try {
    const { code, host } = launcherIn(root);
    fakeNode(join(root, 'bin', 'node'), '22.0.0');
    writeFileSync(join(code, 'node-path'), `${fakeNode(join(root, 'old', 'node'), '20.11.1')}\n`);
    const env = { HOME: join(root, 'home'), PATH: `${join(root, 'bin')}:/usr/bin:/bin` };
    assert.match(launch(host, ['attach'], env).stdout, /^ran 22\.0\.0:/);
    writeFileSync(join(code, 'node-path'), `${join(root, 'nowhere', 'node')}\n`);
    assert.match(launch(host, ['attach'], env).stdout, /^ran 22\.0\.0:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without one on PATH, the launcher takes nvm’s newest version that’s 22 or later, by number', { skip: SKIP }, () => {
  const root = temp('pbl-');
  try {
    const home = join(root, 'home');
    const { host } = launcherIn(root);
    const nvm = join(home, '.nvm', 'versions', 'node');
    fakeNode(join(nvm, 'v9.11.2', 'bin', 'node'), '9.11.2');
    fakeNode(join(nvm, 'v22.2.0', 'bin', 'node'), '22.2.0');
    fakeNode(join(nvm, 'v22.10.0', 'bin', 'node'), '22.10.0');
    fakeNode(join(nvm, 'v18.20.4', 'bin', 'node'), '18.20.4');
    const r = launch(host, ['attach'], { HOME: home, PATH: '/usr/bin:/bin' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ran 22\.10\.0:/, 'v22.10.0 is newer than v22.2.0 and v9.11.2');
    rmSync(nvm, { recursive: true });
    fakeNode(join(home, '.local', 'share', 'mise', 'installs', 'node', '23.1.0', 'bin', 'node'), '23.1.0');
    assert.match(launch(host, ['attach'], { HOME: home, PATH: '/usr/bin:/bin' }).stdout, /^ran 23\.1\.0:/, 'then mise’s');
    rmSync(join(home, '.local'), { recursive: true });
    fakeNode(join(home, '.volta', 'bin', 'node'), '22.0.0');
    assert.match(launch(host, ['attach'], { HOME: home, PATH: '/usr/bin:/bin' }).stdout, /^ran 22\.0\.0:/, 'then Volta’s');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with no node 22 or later, the launcher writes one protocol error naming where it looked and what it found, and exits 69', {
  skip: SKIP || (systemNode && `${systemNode} is Node 22 or later, and the launcher always looks there`),
}, () => {
  const root = temp('pbl-');
  try {
    const home = join(root, 'home');
    const { code, host } = launcherIn(root);
    fakeNode(join(root, 'bin', 'node'), '18.19.0');
    fakeNode(join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin', 'node'), '20.0.0');
    writeFileSync(join(code, 'node-path'), 'relative/node\n');
    const r = launch(host, ['attach'], { HOME: home, PATH: `${join(root, 'bin')}:/usr/bin:/bin` });
    assert.equal(r.code, 69);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 1);
    const checked = validateMessage('daemon-to-postbox', JSON.parse(lines[0]));
    assert.ok(checked.ok, checked.ok ? '' : checked.error);
    const m = /** @type {any} */ (checked.msg);
    assert.equal(m.code, 'no-node');
    for (const s of [
      'needs Node 22 or later',
      'node-path (not an absolute path)',
      `${join(root, 'bin', 'node')} (v18.19.0, older than 22)`,
      `${join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin', 'node')} (v20.0.0, older than 22)`,
      `${home}/.local/share/mise/installs/node/*/bin`,
      `${home}/.volta/bin`,
      '/usr/local/bin; /usr/bin',
      'nodePath',
    ])
      assert.ok(m.message.includes(s), s);
    assert.equal(r.stderr, `postbox host: ${m.message}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the launcher runs the real host.mjs: an unknown command gets the daemon’s usage and 64', { skip: SKIP }, () => {
  const r = launch(LAUNCHER, ['nope'], { HOME: '/nonexistent', PATH: `${NODE_DIR}:/usr/bin:/bin` });
  assert.equal(r.code, 64, r.stderr);
  assert.match(r.stderr, /Usage: host attach/);
});

// ── The install ─────────────────────────────────────────────────────────────────────

/** A spawn that runs ssh’s remote command with /bin/sh -c, as sshd hands it to the login shell, with this environment. */
const localShell = (env) => (_program, args, options) => spawn('/bin/sh', ['-c', args.at(-1)], { ...options, env });

/** A fresh host home and laptop data folder. */
function machines() {
  const root = temp('pbi-');
  const home = join(root, 'h');
  mkdirSync(home);
  const data = join(root, 'data');
  return { root, home, data, env: { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin:/sbin` } };
}

/** Every file and folder under a folder, with its mode. */
const modes = (dir) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .sort()
      .map((f) => [f, statSync(join(dir, f)).mode & 0o777]),
  );

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

// ── A version that’s already there ──────────────────────────────────────────────────

/** Runs the install script on `tar`, as sshd would. */
const installOnce = (m, tar) => spawnSync('/bin/sh', ['-c', installCommand(VERSION)], { input: tar, env: m.env, encoding: 'utf8' });

/** A PID that’s no process’s any more: a child’s, once it has exited. */
const deadPid = () => spawnSync('/bin/sh', ['-c', 'exit 0']).pid;

/** A record naming this test’s own process, as daemon.mjs’s takeDaemonLock and runner.mjs write theirs. */
const liveRecord = (extra = {}) => `${JSON.stringify({ ...extra, pid: process.pid, bootId: bootId(), startTime: startTime(process.pid) })}\n`;

/** What’s in ~/.postbox-remote, sorted, once no install’s start lock is left in its locks folder. */
function top(root) {
  if (existsSync(join(root, 'locks'))) assert.deepEqual(readdirSync(join(root, 'locks')), [], 'no install left its lock');
  return readdirSync(root).sort();
}

test('a second install of the same code says present and leaves the version’s files as they are', { skip: SKIP }, () => {
  const m = machines();
  try {
    const { tar } = bundle({ version: VERSION });
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    const code = join(m.home, '.postbox-remote', VERSION);
    writeFileSync(join(code, 'daemon.log'), 'kept');
    const again = installOnce(m, tar);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `present ${VERSION}\n`);
    assert.equal(readFileSync(join(code, 'daemon.log'), 'utf8'), 'kept');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('an installed file that changed is found and replaced when nothing of that version runs', { skip: SKIP }, () => {
  const m = machines();
  try {
    const { tar, files } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    const changed = join(code, 'server', 'remote', 'host', 'host.mjs');
    writeFileSync(changed, 'console.log("old code");\n');
    // A daemon and a turn of this version that have exited: their records stay, naming dead processes.
    writeFileSync(join(code, 'daemon.pid'), JSON.stringify({ pid: deadPid(), bootId: bootId(), startTime: 1 }));
    const turn = join(root, 'turns', '00000000-0000-4000-8000-000000000001');
    mkdirSync(turn, { recursive: true });
    writeFileSync(join(turn, 'runner.json'), JSON.stringify({ turn: 'x', version: VERSION, pid: deadPid(), bootId: bootId(), startTime: 1 }));
    const r = installOnce(m, tar);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `installed ${VERSION}\n`);
    for (const f of files) assert.deepEqual(readFileSync(join(code, f.path)), f.data, f.path);
    assert.ok(!existsSync(join(code, 'daemon.pid')), 'the old folder went, with its stale daemon.pid');
    assert.deepEqual(top(root), [VERSION, 'locks', 'turns'], 'no temporary or old folder is left');
    // Different code under the same version, consistent with its own manifest, is replaced too.
    writeFileSync(changed, 'console.log("other code");\n');
    writeFileSync(join(code, 'manifest.sha256'), `${createHash('sha256').update('console.log("other code");\n').digest('hex')}  server/remote/host/host.mjs\n`);
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    assert.deepEqual(readFileSync(changed), files.find((f) => f.path === 'server/remote/host/host.mjs')?.data);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('different code under a version whose daemon or turn is live is refused, and left as it is', { skip: SKIP }, async () => {
  const m = machines();
  try {
    const { tar } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    const manifest = join(code, 'manifest.sha256');
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}# another build\n`);
    writeFileSync(join(code, 'daemon.pid'), liveRecord());
    const r = installOnce(m, tar);
    assert.equal(r.status, 75, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(
      r.stderr,
      new RegExp(`Postbox ${VERSION.replaceAll('.', '\\.')} is running on this host with different code; stop its turns, then install again`),
    );
    assert.match(readFileSync(manifest, 'utf8'), /# another build/, 'the running version’s folder is untouched');
    assert.deepEqual(top(root), [VERSION, 'locks']);
    // installHost says so, with the next step.
    await assert.rejects(installHost({ host: HOST, version: VERSION, dataDir: m.data, spawn: localShell(m.env) }), (e) => {
      assert.equal(e.kind, 'failed');
      assert.match(e.message, new RegExp(`Postbox ${V} is running on host\\.example\\.com with different code`));
      assert.match(e.next, /^Stop its turns on host\.example\.com, then install again/);
      return true;
    });
    // A live turn of this version refuses it the same way; one of another version doesn’t.
    rmSync(join(code, 'daemon.pid'));
    const turn = join(root, 'turns', '00000000-0000-4000-8000-000000000002');
    mkdirSync(turn, { recursive: true });
    writeFileSync(join(turn, 'runner.json'), liveRecord({ turn: 'x', version: VERSION }));
    assert.equal(installOnce(m, tar).status, 75);
    writeFileSync(join(turn, 'runner.json'), liveRecord({ turn: 'x', version: '0.9.0' }));
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('different code under a version whose daemon an attach is starting (its start lock, no daemon.pid yet) is refused', { skip: SKIP }, async () => {
  const m = machines();
  try {
    const { tar } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    // Other code under the same version, consistent with its own manifest, so only the lock stops its replacement.
    const changed = join(code, 'server', 'remote', 'host', 'host.mjs');
    writeFileSync(changed, 'console.log("old code");\n');
    const manifest = join(code, 'manifest.sha256');
    writeFileSync(manifest, `${createHash('sha256').update('console.log("old code");\n').digest('hex')}  server/remote/host/host.mjs\n`);
    const before = readFileSync(manifest, 'utf8');
    // The start lock, as daemon.mjs’s takeLock makes it: a folder, held while `host serve` starts.
    const lock = hostPaths(m.home, VERSION).lock;
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    const r = installOnce(m, tar);
    assert.equal(r.status, 75, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`Postbox ${V} is starting on this host; install again in a moment`));
    assert.equal(readFileSync(changed, 'utf8'), 'console.log("old code");\n', 'the starting version’s files are untouched');
    assert.equal(readFileSync(manifest, 'utf8'), before);
    assert.deepEqual(readdirSync(root).sort(), [VERSION, 'locks'], 'no temporary or old folder is left');
    assert.ok(existsSync(lock), 'and the attach’s lock is still its own');
    await assert.rejects(installHost({ host: HOST, version: VERSION, dataDir: m.data, spawn: localShell(m.env) }), (e) => {
      assert.equal(e.kind, 'failed');
      assert.match(e.message, new RegExp(`Postbox ${V} is starting on host\\.example\\.com with different code`));
      assert.match(e.next, /^Install again in a moment/);
      return true;
    });
    // A lock older than LOCK_STALE_MS but not a minute still counts: the script’s age test (find -mmin) is in minutes.
    const ago = (/** @type {number} */ s) => new Date(Date.now() - s * 1000);
    utimesSync(lock, ago(45), ago(45));
    assert.equal(installOnce(m, tar).status, 75);
    // Once the attach drops its lock, nothing of that version runs, and the install replaces it.
    rmSync(lock, { recursive: true });
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    assert.deepEqual(top(root), [VERSION, 'locks']);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a start lock more than a minute old, from an attach that died holding it, doesn’t block an install', { skip: SKIP }, () => {
  const m = machines();
  try {
    const { tar, files } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const changed = join(root, VERSION, 'server', 'remote', 'host', 'host.mjs');
    writeFileSync(changed, 'console.log("old code");\n');
    const lock = hostPaths(m.home, VERSION).lock;
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    // Three minutes: past find -mmin +1 everywhere (BusyBox’s counts whole minutes, so it needs two).
    const old = new Date(Date.now() - 3 * 60_000);
    utimesSync(lock, old, old);
    const r = installOnce(m, tar);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `installed ${VERSION}\n`);
    assert.deepEqual(readFileSync(changed), files.find((f) => f.path === 'server/remote/host/host.mjs')?.data);
    assert.deepEqual(top(root), [VERSION, 'locks'], 'the stale lock went, and the install dropped its own');
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});

/**
 * Starts the install script on `tar` in the background, with one of its test-only pauses: WAIT (POSTBOX_INSTALL_TEST_WAIT),
 * past its first check and before it takes the start lock, or HOLD (POSTBOX_INSTALL_TEST_HOLD), just after it has
 * taken it. It waits there until `go` exists, having made `<go>.paused` or `<go>.held` to say it’s there.
 * @param {ReturnType<typeof machines>} m @param {Buffer} tar @param {string} go @param {'WAIT' | 'HOLD'} [at]
 */
async function installPaused(m, tar, go, at = 'WAIT') {
  const child = spawn('/bin/sh', ['-c', installCommand(VERSION)], { env: { ...m.env, [`POSTBOX_INSTALL_TEST_${at}`]: go }, stdio: ['pipe', 'pipe', 'pipe'] });
  const mark = `${go}.${at === 'WAIT' ? 'paused' : 'held'}`;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
  child.stdin.end(tar);
  /** @type {Promise<{ status: number | null, stdout: string, stderr: string }>} */
  const done = new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
  for (let i = 0; i < 500 && !existsSync(mark); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(mark), `the install paused (${stderr})`);
  return { done, pid: child.pid };
}

/**
 * A real attach, daemon.mjs’s own, in this process: nothing answers on the socket, so it takes the attach lock and
 * starts `host serve` (a fake child here), then waits for it with the lock held, until `end` makes the serve exit.
 */
async function attachStarting(home) {
  /** @type {() => void} */
  let holding = () => {};
  const held = new Promise((r) => (holding = () => r(undefined)));
  /** @type {() => void} */
  let go = () => {};
  const gate = new Promise((r) => (go = () => r(undefined)));
  const serve = Object.assign(new EventEmitter(), { unref() {} });
  const running = main({
    argv: ['attach'],
    home,
    stdin: new PassThrough(),
    stdout: new PassThrough().resume(),
    stderr: { write: () => true },
    spawn: /** @type {any} */ (() => serve),
    // Its first wait is for the serve it started, with the lock held.
    sleep: () => {
      holding();
      return gate;
    },
  });
  await held;
  return {
    async end() {
      serve.emit('exit', 1, null);
      go();
      return running;
    },
  };
}

test('an attach that takes the lock while an install is past its first check makes the install refuse, and the code stays', { skip: SKIP }, async () => {
  const m = machines();
  /** @type {Awaited<ReturnType<typeof attachStarting>> | null} */
  let attach = null;
  try {
    const { tar, files } = bundle({ version: VERSION });
    installOnce(m, tar);
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    const changed = join(code, 'server', 'remote', 'host', 'host.mjs');
    writeFileSync(changed, 'console.log("old code");\n');
    const manifest = join(code, 'manifest.sha256');
    writeFileSync(manifest, `${createHash('sha256').update('console.log("old code");\n').digest('hex')}  server/remote/host/host.mjs\n`);
    const before = modes(code);
    const go = join(m.root, 'go');
    const { done } = await installPaused(m, tar, go);
    // While it waits, an attach finds no daemon and starts one, holding the lock.
    attach = await attachStarting(m.home);
    writeFileSync(go, '');
    const r = await done;
    assert.equal(r.status, 75, `${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`Postbox ${V} is starting on this host; install again in a moment`));
    assert.equal(readFileSync(changed, 'utf8'), 'console.log("old code");\n', 'the starting version’s code is untouched');
    assert.deepEqual(modes(code), { ...before, 'daemon.log': 0o600 }, 'nothing went or came but the attach’s log');
    assert.deepEqual(readdirSync(root).sort(), [VERSION, 'locks'], 'no temporary or old folder is left');
    // Once the attach gives up and drops the lock, the install replaces the code.
    const a = attach;
    attach = null;
    assert.equal(await a.end(), 69);
    const lock = hostPaths(m.home, VERSION).lock;
    for (let i = 0; i < 100 && existsSync(lock); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(!existsSync(lock), 'the attach dropped its lock');
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    assert.deepEqual(readFileSync(changed), files.find((f) => f.path === 'server/remote/host/host.mjs')?.data);
  } finally {
    await attach?.end();
    rmSync(m.root, { recursive: true, force: true });
  }
});

/** Waits up to five seconds for `f()` to be true, and returns it. @param {() => boolean} f */
async function until(f) {
  for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  return f();
}

/**
 * A real attach, daemon.mjs’s own, in this process, counting its waits: it waits while the start lock is held, then
 * takes it and starts `host serve` (a fake child, counted in `spawned`, with the waits before it in `waitsBefore`),
 * holding the lock until `end` makes it exit.
 */
function attachCounting(home) {
  const state = { waits: 0, spawned: 0, waitsBefore: 0 };
  const serve = Object.assign(new EventEmitter(), { unref() {} });
  const running = main({
    argv: ['attach'],
    home,
    stdin: new PassThrough(),
    stdout: new PassThrough().resume(),
    stderr: { write: () => true },
    spawn: /** @type {any} */ (
      () => {
        state.spawned++;
        state.waitsBefore = state.waits;
        return serve;
      }
    ),
    sleep: (ms) => {
      state.waits++;
      return new Promise((r) => setTimeout(r, ms));
    },
  });
  return {
    state,
    end() {
      serve.emit('exit', 1, null);
      return running;
    },
  };
}

/** The start lock’s owner record, parsed, or null if it has none. @param {string} lock */
const lockOwner = (lock) => (existsSync(join(lock, 'owner')) ? JSON.parse(readFileSync(join(lock, 'owner'), 'utf8')) : null);

test('an install holding the start lock past both stale times keeps it: a waiting attach makes nothing, then starts once it’s dropped', {
  skip: SKIP,
}, async () => {
  const m = machines();
  /** @type {ReturnType<typeof attachCounting> | null} */
  let attach = null;
  const hold = join(m.root, 'hold');
  /** @type {Promise<unknown> | null} */
  let install = null;
  try {
    const { tar } = bundle({ version: VERSION });
    const root = join(m.home, '.postbox-remote');
    const code = join(root, VERSION);
    const lock = hostPaths(m.home, VERSION).lock;
    const { done, pid } = await installPaused(m, tar, hold, 'HOLD');
    install = done;
    // Three minutes old, as an install checking turns or deleting a big folder, or suspended, could leave it: past
    // daemon.mjs’s LOCK_STALE_MS and the script’s own minute. Its owner is alive, so it’s held all the same.
    const old = new Date(Date.now() - 3 * 60_000);
    utimesSync(lock, old, old);
    attach = attachCounting(m.home);
    const a = attach;
    await until(() => a.state.waits >= 20 || a.state.spawned > 0);
    assert.equal(a.state.spawned, 0, 'the attach started no daemon');
    assert.equal(existsSync(code), false, 'and made nothing in the version’s folder');
    assert.deepEqual(readdirSync(join(root, 'locks')), [`${VERSION}.lock`], 'nor broke or replaced the lock');
    assert.equal(lockOwner(lock)?.pid, pid, 'which is still the install’s');
    // The script’s record is the one proc.mjs checks: PID, boot ID and start time where there’s /proc, else the PID.
    assert.equal(lockOwnerLive(parseLockOwner(readFileSync(join(lock, 'owner'), 'utf8'))), true, 'and names it as alive');
    if (existsSync('/proc/self/stat')) assert.deepEqual(lockOwner(lock), { pid, bootId: bootId(), startTime: startTime(pid) });
    writeFileSync(hold, '');
    const r = await done;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `installed ${VERSION}\n`);
    // The install dropped its own lock; the attach then took one of its own and started the daemon.
    assert.ok(await until(() => a.state.spawned > 0), 'the attach went on once the install was done');
    assert.equal(a.state.spawned, 1);
    assert.deepEqual(lockOwner(lock), { pid: process.pid, bootId: bootId(), startTime: startTime(process.pid) });
    attach = null;
    assert.equal(await a.end(), 69);
    assert.deepEqual(readdirSync(join(root, 'locks')), [], 'and dropped it');
  } finally {
    await attach?.end();
    writeFileSync(hold, '');
    await install;
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a start lock whose owner is dead is broken at once, however new, by an install and by an attach', { skip: SKIP }, async () => {
  const m = machines();
  /** @type {ReturnType<typeof attachCounting> | null} */
  let attach = null;
  try {
    const { tar } = bundle({ version: VERSION });
    const root = join(m.home, '.postbox-remote');
    const lock = hostPaths(m.home, VERSION).lock;
    const deadLock = () => {
      mkdirSync(lock, { recursive: true, mode: 0o700 });
      writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: deadPid(), bootId: bootId(), startTime: 1 }));
    };
    deadLock();
    const r = installOnce(m, tar);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `installed ${VERSION}\n`);
    assert.deepEqual(top(root), [VERSION, 'locks'], 'the dead owner’s lock went, and the install dropped its own');
    // A PID alone, as the script writes it without /proc, is dead once that PID is.
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: deadPid() }));
    rmSync(join(root, VERSION), { recursive: true });
    assert.equal(installOnce(m, tar).stdout, `installed ${VERSION}\n`);
    deadLock();
    attach = attachCounting(m.home);
    const a = attach;
    assert.ok(await until(() => a.state.spawned > 0), 'the attach broke it and started the daemon');
    assert.equal(a.state.waitsBefore, 0, 'without waiting for it to age');
    assert.equal(lockOwner(lock)?.pid, process.pid);
    attach = null;
    assert.equal(await a.end(), 69);
    assert.deepEqual(readdirSync(join(root, 'locks')), []);
  } finally {
    await attach?.end();
    rmSync(m.root, { recursive: true, force: true });
  }
});

test('a holder whose start lock was broken and taken meanwhile leaves the new one: the install’s exit, and an attach’s', { skip: SKIP }, async () => {
  const m = machines();
  const hold = join(m.root, 'hold');
  /** @type {Promise<unknown> | null} */
  let install = null;
  /** @type {Awaited<ReturnType<typeof attachStarting>> | null} */
  let attach = null;
  try {
    const { tar } = bundle({ version: VERSION });
    const root = join(m.home, '.postbox-remote');
    const lock = hostPaths(m.home, VERSION).lock;
    // Each new lock is one just made, with no record yet: the shape a release by age or name alone would remove.
    const replace = () => {
      rmSync(lock, { recursive: true });
      mkdirSync(lock, { mode: 0o700 });
    };
    const { done } = await installPaused(m, tar, hold, 'HOLD');
    install = done;
    replace();
    writeFileSync(hold, '');
    const r = await done;
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(root, 'locks')), [`${VERSION}.lock`], 'the install left the new lock');
    assert.deepEqual(readdirSync(lock), [], 'as it was');
    rmSync(lock, { recursive: true });
    // An attach holding it while its serve starts, the same.
    attach = await attachStarting(m.home);
    assert.equal(lockOwner(lock)?.pid, process.pid);
    replace();
    const a = attach;
    attach = null;
    assert.equal(await a.end(), 69);
    assert.deepEqual(readdirSync(join(root, 'locks')), [`${VERSION}.lock`], 'the attach left the new lock');
    assert.deepEqual(readdirSync(lock), [], 'as it was');
  } finally {
    await attach?.end();
    writeFileSync(hold, '');
    await install;
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
