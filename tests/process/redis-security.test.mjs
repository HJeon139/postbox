// The store’s Redis is private (#508’s requirements, 4.3, “Store security”, SR-1 to SR-7). These run the real server,
// like tests/process/redis-supervisor.test.mjs, and probe it as an attacker on the same computer would: over TCP,
// without a password, as the default user, and as Postbox’s own user asking for more than the store needs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { RedisSupervisor } from '../../server/redis-supervisor.mjs';

const HOME = process.env.POSTBOX_REDIS_HOME;
if (!HOME) throw new Error('Set POSTBOX_REDIS_HOME to a Redis 8 build with the JSON and search modules (tests/AGENTS.md, “The store’s Redis”).');

let tmp;
before(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pb-redis-sec-')));
});
after(() => rm(tmp, { recursive: true, force: true }));

/** The TCP sockets a process listens on, from lsof. @param {number} pid */
const tcpListeners = (pid) => {
  try {
    return execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
  } catch (e) {
    if (e.status === 1) return ''; // lsof found none
    throw e;
  }
};

/** Whether something accepts a TCP connection on 127.0.0.1:port. @param {number} port */
const accepts = (port) =>
  new Promise((ok) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.destroy();
      ok(true);
    });
    s.once('error', () => ok(false));
  });

test('SR-1: the child listens only on a Unix socket in a folder only the person can open, with port 0', async () => {
  const dataDir = join(tmp, 'sr1');
  const sup = new RedisSupervisor({ home: HOME, dataDir });
  await sup.start();
  try {
    const pid = /** @type {number} */ (sup.child?.pid);
    assert.equal(tcpListeners(pid), '', 'no TCP listener');
    for (const port of [6379, sup.port ?? 0].filter(Boolean)) assert.equal(await accepts(port), false, `nothing on 127.0.0.1:${port}`);
    assert.ok(sup.socket, 'it names its socket');
    assert.ok(statSync(sup.socket).isSocket(), 'the socket exists');
    assert.equal(statSync(join(sup.socket, '..')).mode & 0o777, 0o700, 'its folder is 0700');
    const conf = readFileSync(join(dataDir, 'redis', 'redis.conf'), 'utf8');
    assert.match(conf, /^port 0$/m);
    assert.match(conf, /^unixsocket /m);
    const c = await sup.client();
    assert.equal(await c.call('PING'), 'PONG', 'Postbox reaches it over the socket');
    c.close();
  } finally {
    await sup.stop();
  }
});

test('SR-1: a data folder too long for a socket path gets a short private folder, never TCP', async () => {
  const dataDir = join(tmp, 'a-long-data-folder-name-'.repeat(6));
  const sup = new RedisSupervisor({ home: HOME, dataDir });
  await sup.start();
  try {
    assert.ok(Buffer.byteLength(/** @type {string} */ (sup.socket)) < 104, String(sup.socket));
    assert.equal(statSync(join(/** @type {string} */ (sup.socket), '..')).mode & 0o777, 0o700);
    assert.equal(tcpListeners(/** @type {number} */ (sup.child?.pid)), '');
    const c = await sup.client();
    assert.equal(await c.call('PING'), 'PONG');
    c.close();
  } finally {
    await sup.stop();
  }
});

test('SR-4: Redis 8’s protections are written into the config, and modules load only from it', async () => {
  const dataDir = join(tmp, 'sr4');
  const sup = new RedisSupervisor({ home: HOME, dataDir });
  await sup.start();
  try {
    const conf = readFileSync(join(dataDir, 'redis', 'redis.conf'), 'utf8');
    for (const line of ['enable-protected-configs no', 'enable-debug-command no', 'enable-module-command no', 'protected-mode yes'])
      assert.match(conf, new RegExp(`^${line}$`, 'm'), line);
    assert.equal(conf.match(/^loadmodule /gm)?.length, 2, 'the two modules, and no others');
  } finally {
    await sup.stop();
  }
});
