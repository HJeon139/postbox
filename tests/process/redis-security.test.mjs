// The store’s Redis is private (#508’s requirements, 4.3, “Store security”, SR-1 to SR-7). These run the real server,
// like tests/process/redis-supervisor.test.mjs, and probe it as an attacker on the same computer would: over TCP,
// without a password, as the default user, and as Postbox’s own user asking for more than the store needs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { encode } from '../../server/redis-client.mjs';
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

/** The reply to one command on a raw connection to a socket, as text: what an unauthenticated client gets. */
const rawReply = (path, ...args) =>
  new Promise((ok, fail) => {
    const s = connect({ path });
    s.once('error', fail);
    s.once('connect', () => s.write(encode(args)));
    s.once('data', (d) => {
      s.destroy();
      ok(d.toString());
    });
  });

/** Whether a call is refused by the ACL, as NOPERM or ERR. */
const refused = (p) =>
  p.then(
    (v) => assert.fail(`it ran, and answered ${JSON.stringify(v)}`),
    (e) => assert.match(String(e.message), /^(NOPERM|ERR|WRONGPASS)/, e.message),
  );

test('SR-3: the default user is off, an unauthenticated connection gets NOAUTH, and the default user can’t log in', async () => {
  RedisSupervisor.fixtureUser = true;
  const sup = new RedisSupervisor({ home: HOME, dataDir: join(tmp, 'sr3-default') });
  await sup.start();
  try {
    const path = /** @type {string} */ (sup.socket);
    assert.match(await rawReply(path, 'GET', 'seq'), /^-NOAUTH/);
    assert.match(await rawReply(path, 'AUTH', 'default', ''), /^-WRONGPASS/);
    assert.match(await rawReply(path, 'AUTH', 'anything'), /^-WRONGPASS/);
    const admin = await sup.fixtureClient();
    const def = await admin.call('ACL', 'GETUSER', 'default');
    assert.equal(def[def.indexOf('flags') + 1].includes('off'), true, 'the default user is off');
    admin.close();
  } finally {
    await sup.stop();
    RedisSupervisor.fixtureUser = false;
  }
});

/** What turns store access into more, refused to Postbox’s user directly and from Lua (SR-3). */
const DANGEROUS = [
  ['REPLICAOF', '127.0.0.1', '1'],
  ['SLAVEOF', '127.0.0.1', '1'],
  ['MIGRATE', '127.0.0.1', '1', 'seq', '0', '100'],
  ['CONFIG', 'SET', 'maxmemory', '1'],
  ['CONFIG', 'GET', '*'],
  ['MODULE', 'LIST'],
  ['DEBUG', 'SLEEP', '0'],
  ['ACL', 'SETUSER', 'postbox', '+@all'],
  ['ACL', 'LIST'],
  ['FAILOVER'],
  ['CLUSTER', 'INFO'],
  ['SYNC'],
  ['PSYNC', '?', '-1'],
  ['SHUTDOWN', 'NOSAVE'],
  ['KEYS', '*'],
  ['SCRIPT', 'FLUSH'],
  ['FUNCTION', 'FLUSH'],
  ['CLIENT', 'LIST'],
  ['SAVE'],
  ['BGREWRITEAOF'],
];

test('SR-3: Postbox’s user runs exactly what the store sends, and is refused the rest, directly and from Lua, with no side effect', async () => {
  RedisSupervisor.fixtureUser = true;
  const sup = new RedisSupervisor({ home: HOME, dataDir: join(tmp, 'sr3-acl') });
  await sup.start();
  try {
    const c = await sup.client();
    // What the store sends today (server/store-redis.mjs, store-commit.mjs, store-import.mjs), and its Lua’s calls.
    assert.equal(await c.call('PING'), 'PONG');
    assert.equal(await c.call('SET', 'seq', '1'), 'OK');
    assert.equal(await c.call('GET', 'seq'), '1');
    assert.equal(await c.call('HSET', 'ops', 'op', '1'), 1);
    assert.equal(await c.call('HGET', 'ops', 'op'), '1');
    assert.equal(await c.call('ZADD', 'order:x', '1', 'a'), 1);
    assert.deepEqual(await c.call('ZRANGE', 'order:x', 0, -1), ['a']);
    assert.equal(await c.call('ZREM', 'order:x', 'a'), 1);
    assert.match(await c.call('XADD', 'events', 'MAXLEN', '~', 10, '1-0', 'e', '{}'), /^1-0$/);
    assert.equal((await c.call('XRANGE', 'events', '-', '+')).length, 1);
    assert.equal(await c.call('JSON.SET', 'stage:1', '$', '{"n":1}'), 'OK');
    assert.equal(await c.call('RENAME', 'stage:1', 'doc'), 'OK');
    assert.equal(await c.call('JSON.GET', 'doc', '$'), '[{"n":1}]');
    assert.deepEqual(await c.call('JSON.MGET', 'doc', '$'), ['[{"n":1}]']);
    assert.equal(await c.call('DEL', 'doc'), 1);
    assert.equal(await c.call('EVAL', "redis.pcall('JSON.SET', 'k', '$', '1'); return redis.call('DEL', 'k')", 0), 1);
    assert.ok(Array.isArray(await c.call('WAITAOF', 1, 0, 2000)));
    assert.equal(await c.call('FLUSHDB'), 'OK', 'the importer’s reset, at startup');

    const admin = await sup.fixtureClient();
    const before = { maxmemory: await admin.call('CONFIG', 'GET', 'maxmemory'), role: String(await admin.call('INFO', 'replication')).match(/role:\w+/)?.[0] };
    for (const cmd of DANGEROUS) {
      await refused(c.call(...cmd));
      const lua = `return redis.call(${cmd.map((a) => `'${a}'`).join(', ')})`;
      await refused(c.call('EVAL', lua, 0));
    }
    assert.equal(await c.call('PING'), 'PONG', 'the connection is still Postbox’s');
    assert.deepEqual(
      { maxmemory: await admin.call('CONFIG', 'GET', 'maxmemory'), role: String(await admin.call('INFO', 'replication')).match(/role:\w+/)?.[0] },
      before,
      'nothing changed',
    );
    assert.equal(sup.child?.exitCode, null, 'it’s still running');
    admin.close();
    c.close();
  } finally {
    await sup.stop();
    RedisSupervisor.fixtureUser = false;
  }
});

test('SR-2: no password is on a command line or in a log, the config holds only hashes, and stored copies are 0600', async () => {
  const dataDir = join(tmp, 'sr2');
  // An earlier version left these readable by others: the start makes them private again.
  mkdirSync(join(dataDir, 'redis'), { recursive: true });
  for (const f of ['redis.conf', 'owner.json']) writeFileSync(join(dataDir, 'redis', f), '', { mode: 0o644 });
  const sup = new RedisSupervisor({ home: HOME, dataDir });
  await sup.start();
  try {
    const secrets = [sup.password, sup.ownerPassword];
    const pid = /** @type {number} */ (sup.child?.pid);
    const argv = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    const mine = execFileSync('ps', ['-o', 'args=', '-p', String(process.pid)], { encoding: 'utf8' });
    const conf = readFileSync(join(dataDir, 'redis', 'redis.conf'), 'utf8');
    const c = await sup.client();
    await c.call('SET', 'k', 'v');
    c.close();
    await sup.stop();
    const log = readFileSync(join(dataDir, 'redis', 'logs', 'redis.log'), 'utf8');
    for (const secret of secrets) {
      for (const [where, text] of Object.entries({ argv, mine, conf, log })) assert.ok(!text.includes(secret), `not in ${where}`);
    }
    assert.match(conf, /^user postbox on #[0-9a-f]{64} /m);
    for (const f of ['redis.conf', 'owner.json']) assert.equal(statSync(join(dataDir, 'redis', f)).mode & 0o777, 0o600, f);
  } finally {
    await sup.stop();
  }
});
