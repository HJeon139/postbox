// Installing Postbox on a remote host (server/remote/install.mjs, #120 L2), with a fake ssh: the fixed command lines,
// what ships (the tar, the manifest, node-path), each failure in words, the laptop’s copy of the token and the confirm’s
// text. Nothing runs: ssh is a fake child that answers as the host would. tests/integration/remote-install.test.mjs
// runs the real script with sh and tar.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  bundle,
  describeInstall,
  forgetToken,
  INSTALL_SCRIPT,
  installArgs,
  installCommand,
  installHost,
  MANIFEST,
  NODE_PATH_FILE,
  readToken,
  tokenCommand,
  tokenFile,
  ustar,
} from '../server/remote/install.mjs';
import { SshFailure, sshArgs } from '../server/remote/ssh.mjs';
import { checkHostSettings, defaultHostSettings } from '../shared/remote-settings.mjs';

const VERSION = '0.10.0';
const HOST = { id: 'ho_abc12345', name: 'host.example.com', settings: defaultHostSettings() };
const TOKEN = 'a'.repeat(64);
const MTIME = 1_700_000_000;

/** @param {object} patch */
const withSettings = (patch) => {
  const r = checkHostSettings(patch);
  assert.ok(r.ok);
  return { ...HOST, settings: r.value };
};

/** A temp data folder. */
const dataDir = () => mkdtempSync(join(tmpdir(), 'pb-install-'));

/** Reads a ustar archive back: each entry’s name, mode, size, mtime and data, checking each header’s checksum. @param {Buffer} tar */
function untar(tar) {
  const out = [];
  let at = 0;
  for (;;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (o, n) => h.toString('ascii', o, o + n).replace(/\0.*$/s, '');
    const num = (o, n) => parseInt(field(o, n), 8);
    const sum = [...h].reduce((a, b, i) => a + (i >= 148 && i < 156 ? 0x20 : b), 0);
    assert.equal(num(148, 8), sum, 'the header’s checksum');
    assert.equal(field(257, 6), 'ustar');
    assert.equal(field(263, 2), '00');
    assert.equal(field(156, 1), '0');
    const size = num(124, 12);
    out.push({
      path: field(0, 100),
      mode: num(100, 8),
      uid: num(108, 8),
      gid: num(116, 8),
      size,
      mtime: num(136, 12),
      data: tar.subarray(at + 512, at + 512 + size),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(tar.length, at + 1024, 'two zero blocks end it');
  assert.ok(tar.subarray(at).every((b) => b === 0));
  return out;
}

/**
 * A fake ssh: each spawn answers from `answers`, in order, once its stdin ends, as the host would.
 * @param {({ code?: number | null, signal?: string | null, stdout?: string, stderr?: string, hang?: boolean, error?: any } | undefined)[]} answers
 */
function fakeSsh(answers) {
  const calls = [];
  const spawn = (program, args, options) => {
    const answer = answers[calls.length] ?? { code: 0 };
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), kills: [] });
    const call = { program, args, options, input: Buffer.alloc(0), child };
    calls.push(call);
    const chunks = [];
    stdin.on('data', (b) => chunks.push(b));
    const exit = (code, signal = null) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    child.kill = (signal) => {
      child.kills.push(signal);
      exit(null, signal);
      return true;
    };
    stdin.on('end', () => {
      call.input = Buffer.concat(chunks);
      if (answer.error) return setImmediate(() => child.emit('error', answer.error));
      if (answer.hang) return;
      if (answer.stdout) child.stdout.write(answer.stdout);
      if (answer.stderr) child.stderr.write(answer.stderr);
      exit(answer.code ?? 0, answer.signal ?? null);
    });
    return child;
  };
  return { spawn, calls };
}

const installed = { code: 0, stdout: `installed ${VERSION}\n` };
const tokenAnswer = { code: 0, stdout: `${TOKEN}\n`, stderr: 'postbox host: Made the token at /home/user/.postbox-remote/token.\n' };

// ── The commands ────────────────────────────────────────────────────────────────────

test('the install command is the fixed script, then only the checked version', () => {
  assert.equal(installCommand(VERSION), `/bin/sh -c '${INSTALL_SCRIPT}' postbox-install 0.10.0`);
  assert.equal(installCommand('1.2.3-rc.1').endsWith(`' postbox-install 1.2.3-rc.1`), true);
  for (const v of ['0.10.0; rm -rf ~', '$(id)', '../0.9.0', '0.10.0 x', '', '`id`', "0.1'"]) assert.throws(() => installCommand(v), TypeError, v);
});

test('the install script survives any login shell: one line, ASCII, with no single quote, ! or fish escape', () => {
  assert.ok(!INSTALL_SCRIPT.includes("'"), 'no single quote, which would end the quoting');
  assert.ok(!INSTALL_SCRIPT.includes('\n'), 'one line: csh refuses a new line inside quotes');
  assert.ok(!INSTALL_SCRIPT.includes('!'), 'no !, which csh expands even inside single quotes');
  assert.ok(!INSTALL_SCRIPT.includes('\\\\') && !INSTALL_SCRIPT.includes("\\'"), 'no \\\\ or \\’, which fish unescapes inside single quotes');
  assert.match(INSTALL_SCRIPT, /^[\x20-\x7e]+$/, 'printable ASCII only');
  assert.match(INSTALL_SCRIPT, /^set -eu; umask 077; /);
});

test('the token command is the version’s launcher with token', () => {
  assert.equal(tokenCommand(VERSION), '~/.postbox-remote/0.10.0/server/remote/host/host token');
  assert.throws(() => tokenCommand('0.10.0 attach'), TypeError);
});

test('install runs ssh with L1’s fixed options and destination, and only the command differs', () => {
  const base = sshArgs({ destination: HOST.name, settings: HOST.settings, version: VERSION });
  const args = installArgs(HOST, VERSION, installCommand(VERSION));
  assert.deepEqual(args.slice(0, -1), base.slice(0, -1));
  assert.ok(args.includes('BatchMode=yes') && args.includes('ControlPath=none') && args.includes('ForwardAgent=no'));
  assert.equal(args.at(-1), installCommand(VERSION));
  assert.equal(args.at(-2), HOST.name);
  assert.throws(() => installArgs({ ...HOST, name: '-oProxyCommand=x' }, VERSION, 'x'), TypeError);
});

// ── What ships ──────────────────────────────────────────────────────────────────────

test('the tar is ustar: valid checksums, the launcher 0700, the rest 0600, no owner, the given time', () => {
  const b = bundle({ version: VERSION, mtime: MTIME });
  const entries = untar(b.tar);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  assert.equal(byPath.get('server/remote/host/host')?.mode, 0o700);
  for (const e of entries) {
    if (e.path !== 'server/remote/host/host') assert.equal(e.mode, 0o600, e.path);
    assert.equal(e.uid, 0);
    assert.equal(e.gid, 0);
    assert.equal(e.mtime, MTIME);
  }
  assert.ok(byPath.has('server/remote/host/host.mjs') && byPath.has('shared/remote-protocol.mjs') && byPath.has(MANIFEST));
  assert.ok(!byPath.has(NODE_PATH_FILE), 'no node-path without a nodePath setting');
  assert.ok(![...byPath.keys()].some((p) => p.startsWith('tests/') || p === 'server/index.mjs'));
  assert.deepEqual(bundle({ version: VERSION, mtime: MTIME }).tar, b.tar, 'the same bytes each time');
});

test('the manifest has every shipped file’s SHA-256, in sha256sum’s format, and package.json names the version', () => {
  const b = bundle({ version: VERSION, mtime: MTIME });
  const entries = new Map(untar(b.tar).map((e) => [e.path, e.data]));
  const lines = b.manifest.trimEnd().split('\n');
  assert.equal(lines.length, b.files.length);
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    assert.ok(m, line);
    assert.equal(
      createHash('sha256')
        .update(/** @type {Buffer} */ (entries.get(m[2])))
        .digest('hex'),
      m[1],
      m[2],
    );
  }
  assert.equal(entries.get(MANIFEST)?.toString(), b.manifest);
  assert.ok(!b.manifest.includes(MANIFEST), 'the manifest doesn’t list itself');
  const pkg = JSON.parse(String(entries.get('package.json')));
  assert.deepEqual(pkg, { name: 'postbox', version: VERSION, private: true, type: 'module' });
  // Each shipped file is the repo’s, byte for byte.
  assert.deepEqual(entries.get('server/remote/host/host'), readFileSync(new URL('../server/remote/host/host', import.meta.url)));
});

test('a nodePath setting ships as node-path, beside the manifest rather than in it; a bad one is refused', () => {
  const b = bundle({ version: VERSION, nodePath: '/opt/node-22/bin/node', mtime: MTIME });
  const np = untar(b.tar).find((e) => e.path === NODE_PATH_FILE);
  assert.equal(np?.data.toString(), '/opt/node-22/bin/node\n');
  assert.equal(np?.mode, 0o600);
  assert.ok(!b.manifest.includes(NODE_PATH_FILE));
  for (const bad of ['node', '~/bin/node', '/opt/../node', '/opt/node\n/x']) assert.throws(() => bundle({ version: VERSION, nodePath: bad }), TypeError, bad);
});

test('ustar refuses a name it can’t carry', () => {
  assert.throws(() => ustar([{ path: '../x', data: Buffer.alloc(0), mode: 0o600 }], 0), TypeError);
  assert.throws(() => ustar([{ path: `${'a'.repeat(101)}`, data: Buffer.alloc(0), mode: 0o600 }], 0), TypeError);
  assert.throws(() => ustar([{ path: 'a b', data: Buffer.alloc(0), mode: 0o600 }], 0), TypeError);
});

// ── Installing ──────────────────────────────────────────────────────────────────────

test('installHost sends the tar on stdin, then gets the token, and keeps it 0600 in a 0700 folder under the data folder', async () => {
  const dir = dataDir();
  try {
    const ssh = fakeSsh([installed, tokenAnswer]);
    const r = await installHost({ host: HOST, version: VERSION, dataDir: dir, spawn: ssh.spawn, mtime: MTIME });
    assert.deepEqual(r, { token: TOKEN, installed: true, version: VERSION });
    assert.equal(ssh.calls.length, 2);
    assert.deepEqual(
      ssh.calls.map((c) => [c.program, c.args.at(-1)]),
      [
        ['ssh', installCommand(VERSION)],
        ['ssh', tokenCommand(VERSION)],
      ],
    );
    assert.deepEqual(ssh.calls[0].options, { stdio: ['pipe', 'pipe', 'pipe'] });
    assert.deepEqual(ssh.calls[0].input, bundle({ version: VERSION, mtime: MTIME }).tar);
    assert.equal(ssh.calls[1].input.length, 0, 'the token run gets nothing on stdin');
    for (const c of ssh.calls) assert.ok(!c.args.some((a) => a.includes(TOKEN)));
    const file = join(dir, 'remote-tokens', HOST.id);
    assert.equal(readFileSync(file, 'utf8'), `${TOKEN}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'remote-tokens')).mode & 0o777, 0o700);
    assert.equal(await readToken({ dataDir: dir, hostId: HOST.id }), TOKEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version already on the host is reported as not installed, and the token is still fetched', async () => {
  const dir = dataDir();
  try {
    const ssh = fakeSsh([{ code: 0, stdout: `present ${VERSION}\n` }, tokenAnswer]);
    const r = await installHost({ host: HOST, version: VERSION, dataDir: dir, spawn: ssh.spawn });
    assert.equal(r.installed, false);
    assert.equal(r.token, TOKEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** installHost’s failure, with the fake ssh’s answers. */
async function failing(answers, host = HOST) {
  const dir = dataDir();
  try {
    const ssh = fakeSsh(answers);
    const e = await installHost({ host, version: VERSION, dataDir: dir, spawn: ssh.spawn }).then(
      () => assert.fail('it installed'),
      (err) => err,
    );
    assert.ok(e instanceof SshFailure, String(e));
    assert.equal(await readToken({ dataDir: dir, hostId: host.id }), null, 'no token kept');
    return { e, calls: ssh.calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ssh’s own failures are L1’s classes, and the token run doesn’t start', async () => {
  const signIn = await failing([{ code: 255, stderr: 'user@host.example.com: Permission denied (publickey).\r\n' }]);
  assert.equal(signIn.e.kind, 'sign-in');
  assert.match(signIn.e.next, /ssh host\.example\.com/);
  assert.equal(signIn.calls.length, 1);
  const key = await failing([{ code: 255, stderr: 'Host key verification failed.\r\n' }]);
  assert.equal(key.e.kind, 'host-key');
  const down = await failing([{ code: 255, stderr: 'ssh: connect to host host.example.com port 22: Connection refused\r\n' }]);
  assert.equal(down.e.kind, 'unreachable');
  const missing = await failing([{ error: Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }) }]);
  assert.equal(missing.e.kind, 'failed');
  assert.match(missing.e.message, /ssh isn’t installed or isn’t on PATH/);
});

test('the script’s failures say what happened and what to do', async () => {
  const sum = await failing([
    { code: 66, stderr: 'shared/limits.mjs: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match\npostbox install: checksums did not match\n' },
  ]);
  assert.equal(sum.e.kind, 'failed');
  assert.match(sum.e.message, /couldn’t install its host program on host\.example\.com: a file’s SHA-256 on the host didn’t match the manifest/);
  assert.match(sum.e.message, /did NOT match/);
  assert.match(sum.e.next, /^Install again/);
  const running = await failing([
    { code: 75, stderr: 'postbox install: Postbox 0.10.0 is running on this host with different code; stop its turns, then install again\n' },
  ]);
  assert.equal(running.e.kind, 'failed');
  assert.match(
    running.e.message,
    /couldn’t install its host program on host\.example\.com: Postbox 0\.10\.0 is running on host\.example\.com with different code\./,
  );
  assert.match(running.e.next, /^Stop its turns on host\.example\.com, then install again\./);
  // The same exit while an attach holds the start lock, starting the daemon: try again soon.
  const starting = await failing([{ code: 75, stderr: 'postbox install: Postbox 0.10.0 is starting on this host; install again in a moment\n' }]);
  assert.equal(starting.e.kind, 'failed');
  assert.match(
    starting.e.message,
    /couldn’t install its host program on host\.example\.com: Postbox 0\.10\.0 is starting on host\.example\.com with different code\./,
  );
  assert.match(starting.e.next, /^Install again in a moment\. If Postbox then says it’s running on host\.example\.com, stop its turns there first\.$/);
  const link = await failing([
    {
      code: 77,
      stderr: 'postbox install: /home/user/.postbox-remote, /home/user/.postbox-remote/0.10.0 or /home/user/.postbox-remote/locks is a symbolic link\n',
    },
  ]);
  assert.match(link.e.message, /~\/\.postbox-remote, or the version’s folder or locks folder there, is a symbolic link/);
  assert.match(
    link.e.next,
    /replace the symbolic link at ~\/\.postbox-remote, ~\/\.postbox-remote\/0\.10\.0 or ~\/\.postbox-remote\/locks with a folder of your own/,
  );
  const tool = await failing([{ code: 69 }]);
  assert.match(tool.e.message, /no sha256sum, shasum or node/);
  assert.match(tool.e.next, /coreutils/);
  const disk = await failing([{ code: 1, stderr: 'mkdir: cannot create directory ‘/home/user/.postbox-remote’: No space left on device\n' }]);
  assert.match(disk.e.message, /exit status 1: “mkdir: cannot create directory .*No space left on device”/);
  const odd = await failing([{ code: 0, stdout: 'Welcome to host.example.com\n' }]);
  assert.match(odd.e.message, /answered “Welcome to host\.example\.com” instead/);
});

test('a host without a usable Node is found at the token step, in the launcher’s words', async () => {
  const said =
    'Postbox’s host program needs Node 22 or later, and found none on this host. It looked in: /usr/bin/node (v18.19.0, older than 22); PATH (/usr/bin:/bin). Install Node 22 or later, or set this host’s nodePath in Postbox to its full path and install again.';
  const { e, calls } = await failing([
    installed,
    { code: 69, stdout: `${JSON.stringify({ type: 'error', code: 'no-node', message: said })}\n`, stderr: `postbox host: ${said}\n` },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(e.kind, 'no-node');
  assert.equal(e.retry, false);
  assert.match(e.next, /^Install Node 22 or later on host\.example\.com, or set its Node path in Postbox’s host settings/);
  assert.ok(e.message.includes(said));
  assert.match(e.message, /^Postbox installed its files on host\.example\.com, but its host program couldn’t start there/);
});

test('a token run that prints no token, or can’t find the launcher, fails without keeping anything', async () => {
  const junk = await failing([installed, { code: 0, stdout: 'not a token\n' }]);
  assert.match(junk.e.message, /didn’t get the daemon’s token back/);
  const gone = await failing([installed, { code: 127, stderr: 'sh: 1: /home/user/.postbox-remote/0.10.0/server/remote/host/host: not found\n' }]);
  assert.equal(gone.e.kind, 'not-installed');
});

test('an install that doesn’t finish is stopped and said to be unreachable', async () => {
  const dir = dataDir();
  try {
    const ssh = fakeSsh([{ hang: true }]);
    /** @type {(() => void)[]} */
    const timers = [];
    const running = installHost({
      host: HOST,
      version: VERSION,
      dataDir: dir,
      spawn: ssh.spawn,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
      installTimeout: 1000,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.length, 1);
    timers[0]();
    const e = await running.then(
      () => assert.fail('it installed'),
      (err) => err,
    );
    assert.equal(e.kind, 'unreachable');
    assert.deepEqual(ssh.calls[0].child.kills, ['SIGKILL']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad host, version or nodePath is refused before ssh starts', async () => {
  const ssh = fakeSsh([]);
  const dir = dataDir();
  try {
    const bad = [
      { host: { ...HOST, id: '../x' }, version: VERSION },
      { host: { ...HOST, name: '-oProxyCommand=x' }, version: VERSION },
      { host: HOST, version: '0.10.0;id' },
      { host: { ...HOST, settings: { ...HOST.settings, nodePath: 'node' } }, version: VERSION },
    ];
    for (const o of bad) await assert.rejects(installHost({ ...o, dataDir: dir, spawn: ssh.spawn }), TypeError);
    assert.equal(ssh.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The laptop’s token ──────────────────────────────────────────────────────────────

test('readToken and forgetToken: one file per host, none is null, and only a regular file with a token counts', async () => {
  const dir = dataDir();
  try {
    assert.equal(await readToken({ dataDir: dir, hostId: HOST.id }), null);
    assert.equal(await forgetToken({ dataDir: dir, hostId: HOST.id }), false);
    const file = tokenFile(dir, HOST.id);
    assert.equal(file, join(dir, 'remote-tokens', HOST.id));
    mkdirSync(join(dir, 'remote-tokens'), { mode: 0o700 });
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    assert.equal(await readToken({ dataDir: dir, hostId: HOST.id }), TOKEN);
    assert.equal(await readToken({ dataDir: dir, hostId: 'ho_other' }), null);
    assert.equal(await forgetToken({ dataDir: dir, hostId: HOST.id }), true);
    assert.equal(await readToken({ dataDir: dir, hostId: HOST.id }), null);
    writeFileSync(join(dir, 'elsewhere'), TOKEN);
    symlinkSync(join(dir, 'elsewhere'), file);
    assert.equal(await readToken({ dataDir: dir, hostId: HOST.id }), null, 'a symlink isn’t followed');
    assert.equal(await forgetToken({ dataDir: dir, hostId: HOST.id }), true);
    assert.ok(lstatSync(join(dir, 'elsewhere')).isFile(), 'forgetting removes the link, not what it points at');
    writeFileSync(file, 'short');
    assert.equal(await readToken({ dataDir: dir, hostId: HOST.id }), null);
    for (const id of ['', '../store.json', 'a/b', 'x'.repeat(65)]) assert.throws(() => tokenFile(dir, id), TypeError, id);
    assert.throws(() => tokenFile('', HOST.id), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The confirm ─────────────────────────────────────────────────────────────────────

test('describeInstall names every path it writes on both machines, and the commands', () => {
  const d = describeInstall(HOST, { version: VERSION, dataDir: '/Users/user/postbox/data' });
  assert.equal(d.destination, 'host.example.com');
  assert.deepEqual(d.host, { root: '~/.postbox-remote', code: '~/.postbox-remote/0.10.0', token: '~/.postbox-remote/token', nodePath: null });
  assert.deepEqual(d.laptop, { token: '/Users/user/postbox/data/remote-tokens/ho_abc12345' });
  assert.deepEqual(d.commands, [installCommand(VERSION), tokenCommand(VERSION)]);
  assert.equal(d.steps.length, 4);
  for (const s of ['~/.postbox-remote/0.10.0/', '~/.postbox-remote/token', '/Users/user/postbox/data/remote-tokens/ho_abc12345', 'SHA-256', 'Node 22'])
    assert.ok(d.text.includes(s), s);
  assert.match(d.text, /^Install Postbox’s host program on host\.example\.com\?/);
  const files = bundle({ version: VERSION }).files.length;
  assert.ok(d.text.includes(`Copy ${files} files`), 'the count matches what ships');
  const withNode = describeInstall(withSettings({ nodePath: '/opt/node/bin/node' }), { version: VERSION, dataDir: '/data' });
  assert.equal(withNode.host.nodePath, '~/.postbox-remote/0.10.0/node-path');
  assert.ok(withNode.text.includes('/opt/node/bin/node'));
});
