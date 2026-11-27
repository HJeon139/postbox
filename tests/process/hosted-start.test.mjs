// The start command of the hosted server’s image (infra/image/hosted-start.sh; designs/architecture/hosted.md, “What
// runs an agent host, weighed”): it writes ssh’s files from what the deployment gives it, and the agent host’s
// identity among that is what the machine said, which an agent there can say again differently. So it becomes a line
// of known_hosts only when it is one ed25519 key and nothing more. It runs sh, which tests/guard.mjs keeps out of the
// unit tests, so it’s under tests/process/. A stand-in `node` first on PATH records what Postbox would be started with.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../infra/image/hosted-start.sh', import.meta.url));
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----';
const IDENTITY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureFixtureFixtureFixtureFixtureFixtureFix';
const HOST = { POSTBOX_HOST_KEY: KEY, POSTBOX_HOST_ADDRESS: '10.0.3.7', POSTBOX_HOST_IDENTITY: IDENTITY };

/** Runs the start command in a home of its own, with nothing in its environment but what is given. */
function start(
  /** @type {Record<string, string>} */ given,
  /** @type {(run: { home: string, status: number | null, stderr: string, started: string }) => void} */ check,
) {
  const home = mkdtempSync(join(tmpdir(), 'postbox-hosted-start-'));
  try {
    mkdirSync(join(home, 'bin'));
    // What Postbox would be started with: its arguments, then every variable it would inherit.
    writeFileSync(join(home, 'bin', 'node'), '#!/bin/sh\necho "args: $*" > "$HOME/started"\nenv >> "$HOME/started"\n');
    chmodSync(join(home, 'bin', 'node'), 0o755);
    const env = { HOME: home, PATH: `${join(home, 'bin')}:/usr/bin:/bin`, POSTBOX_HOSTED: '{"origin":"https://postbox.example"}', ...given };
    const run = spawnSync('sh', [SCRIPT], { env, encoding: 'utf8', timeout: 20_000 });
    check({ home, status: run.status, stderr: run.stderr, started: existsSync(join(home, 'started')) ? readFileSync(join(home, 'started'), 'utf8') : '' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const mode = (/** @type {string} */ path) => (statSync(path).mode & 0o777).toString(8);

test('with a host, ssh’s three files are written for the account alone, and Postbox starts with none of it in its environment', () => {
  start(HOST, ({ home, status, started }) => {
    assert.equal(status, 0);
    const ssh = join(home, '.ssh');
    assert.equal(mode(ssh), '700');
    for (const file of ['agent-host', 'known_hosts', 'config']) assert.equal(mode(join(ssh, file)), '600', file);
    assert.equal(readFileSync(join(ssh, 'agent-host'), 'utf8'), `${KEY}\n`);
    assert.equal(readFileSync(join(ssh, 'known_hosts'), 'utf8'), `agents ${IDENTITY}\n`);
    const config = readFileSync(join(ssh, 'config'), 'utf8');
    for (const line of ['Host agents', '  HostName 10.0.3.7', '  HostKeyAlias agents', '  User postbox', `  IdentityFile ${ssh}/agent-host`])
      assert.ok(config.includes(`${line}\n`), line);
    assert.match(started, new RegExp(`^args: bin/postbox.mjs --hosted ${home}/hosted.json --data /data --port 8080\n`));
    assert.doesNotMatch(started, /POSTBOX_HOST|POSTBOX_HOSTED|OPENSSH/);
    assert.equal(readFileSync(join(home, 'hosted.json'), 'utf8'), '{"origin":"https://postbox.example"}');
  });
});

test('an identity or address that would be more than its own line of a file ssh trusts sets up no host, and Postbox still starts', () => {
  const unfit = {
    'a second line, which would be a key for every host': { POSTBOX_HOST_IDENTITY: `${IDENTITY}\n* ssh-ed25519 AAAAOTHER` },
    'a certificate authority on a second line': { POSTBOX_HOST_IDENTITY: `${IDENTITY}\n@cert-authority * ssh-ed25519 AAAAOTHER` },
    'another kind of key': { POSTBOX_HOST_IDENTITY: 'ssh-rsa AAAAB3NzaC1yc2E' },
    'a key with a comment after it': { POSTBOX_HOST_IDENTITY: `${IDENTITY} someone` },
    'what a late signal could say': { POSTBOX_HOST_IDENTITY: 'failed' },
    'an address with a space': { POSTBOX_HOST_ADDRESS: '10.0.3.7 x' },
    'an address of two lines': { POSTBOX_HOST_ADDRESS: '10.0.3.7\n  ProxyCommand x' },
  };
  for (const [what, over] of Object.entries(unfit))
    start({ ...HOST, ...over }, ({ home, status, stderr, started }) => {
      assert.equal(status, 0, what);
      assert.equal(existsSync(join(home, '.ssh')), false, `${what}: no file for ssh is written`);
      assert.match(stderr, /the host “agents” isn’t set up/, what);
      assert.match(started, /^args: bin\/postbox\.mjs --hosted /, `${what}: Postbox still starts`);
      assert.doesNotMatch(started, /POSTBOX_HOST/, what);
    });
});

test('with no host, only the settings file is written', () => {
  start({}, ({ home, status, started }) => {
    assert.equal(status, 0);
    assert.equal(existsSync(join(home, '.ssh')), false);
    assert.equal(mode(join(home, 'hosted.json')), '600');
    assert.match(started, /^args: bin\/postbox\.mjs/);
  });
});
