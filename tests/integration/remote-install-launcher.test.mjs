// The `host` launcher (server/remote/host/host, #120 L2), with real sh: which node it runs host.mjs with (node-path’s,
// PATH’s, then nvm’s newest 22 or later), and the one protocol error it writes when there’s none. Its nodes are fakes,
// small sh scripts that print a version and their arguments. No network; nothing touches the real home folder.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateMessage } from '../../shared/remote-protocol.mjs';
import { NODE_DIR, SKIP, temp, VERSION } from './remote-install-fixtures.mjs';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'remote', 'host', 'host');

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
