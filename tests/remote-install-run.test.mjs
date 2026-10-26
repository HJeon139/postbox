// Running an install (server/remote/install.mjs, #120 L2) with a fake ssh: the two ssh runs, each failure in words,
// and the laptop’s copy of the token. Nothing runs: ssh is a fake child that answers as the host would.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { bundle, forgetToken, installCommand, installHost, readToken, tokenCommand, tokenFile } from '../server/remote/install.mjs';
import { SshFailure } from '../server/remote/ssh.mjs';
import { HOST, MTIME, VERSION } from './remote-install-fixtures.mjs';

const TOKEN = 'a'.repeat(64);

/** A temp data folder. */
const dataDir = () => mkdtempSync(join(tmpdir(), 'pb-install-'));

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
