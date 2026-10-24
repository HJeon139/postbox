// Installing Postbox on a remote host (server/remote/install.mjs, #120 L2): the fixed command lines, what ships (the
// tar, the manifest, node-path) and the confirm’s text. Running it with a fake ssh, each failure in words and the
// laptop’s copy of the token are in remote-install-run.test.mjs. Nothing runs here:
// tests/integration/remote-install.test.mjs runs the real script with sh and tar.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  bundle,
  describeInstall,
  INSTALL_SCRIPT,
  installArgs,
  installCommand,
  MANIFEST,
  NODE_PATH_FILE,
  tokenCommand,
  ustar,
} from '../server/remote/install.mjs';
import { sshArgs } from '../server/remote/ssh.mjs';
import { checkHostSettings } from '../shared/remote-settings.mjs';
import { HOST, MTIME, VERSION } from './remote-install-fixtures.mjs';

/** @param {object} patch */
const withSettings = (patch) => {
  const r = checkHostSettings(patch);
  assert.ok(r.ok);
  return { ...HOST, settings: r.value };
};

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
