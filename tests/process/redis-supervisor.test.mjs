// The store’s Redis child (server/redis-supervisor.mjs; designs/508/design.md, “Storage: a Redis 8 server that Postbox
// bundles and runs”, decisions 1, 3 and 7, and “Failure modes”). These run the real server: POSTBOX_REDIS_HOME names a
// Redis 8 build with the JSON and search modules (tests/AGENTS.md says how to get one). They start that binary and
// connect to it, so they live in tests/process/, which runs without the guard.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RedisSupervisor, redisFiles } from '../../server/redis-supervisor.mjs';

const HOME = process.env.POSTBOX_REDIS_HOME;
if (!HOME) throw new Error('Set POSTBOX_REDIS_HOME to a Redis 8 build with the JSON and search modules (tests/AGENTS.md, “The store’s Redis”).');

let tmp;
before(async () => {
  // Its real path: Redis reports its dir that way, and macOS’s temp folder is behind a link.
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pb-redis-sup-')));
});
after(() => rm(tmp, { recursive: true, force: true }));

/** Waits until the supervisor reports a state, or fails after a few seconds. */
function until(sup, pred, what) {
  if (pred(sup.status)) return Promise.resolve(sup.status);
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`timed out waiting for ${what}; status ${JSON.stringify(sup.status)}`)), 8000);
    const on = (s) => {
      if (!pred(s)) return;
      clearTimeout(t);
      sup.off('status', on);
      ok(s);
    };
    sup.on('status', on);
  });
}

test('the child runs on a port Postbox picks, on 127.0.0.1, with AOF everysec, both modules, and its files in the data folder', async () => {
  const dataDir = join(tmp, 'runs');
  const sup = new RedisSupervisor({ home: HOME, dataDir });
  await sup.start();
  try {
    assert.equal(sup.status.state, 'running');
    assert.ok(sup.port > 0);
    const c = await sup.client();
    const flat = await c.call('CONFIG', 'GET', '*');
    const conf = Object.fromEntries(flat.flatMap((v, i) => (i % 2 ? [] : [[v, flat[i + 1]]])));
    assert.equal(conf.bind, '127.0.0.1');
    assert.equal(conf.port, String(sup.port));
    assert.equal(conf.appendonly, 'yes');
    assert.equal(conf.appendfsync, 'everysec');
    assert.equal(conf.dir, join(dataDir, 'redis', 'data'));
    const modules = (await c.call('MODULE', 'LIST')).map((m) => m[1]);
    assert.ok(modules.includes('ReJSON') && modules.includes('search'), String(modules));
    assert.equal(await c.call('JSON.SET', 'doc', '$', '{"n":1}'), 'OK');
    c.close();
    assert.ok((await readdir(join(dataDir, 'redis'))).includes('redis.conf'));
    assert.match(await readFile(join(dataDir, 'redis', 'logs', 'redis.log'), 'utf8'), /Ready to accept connections/);
  } finally {
    await sup.stop();
  }
});

test('a missing binary fails the start with the cause named, and nothing is spawned', async () => {
  const sup = new RedisSupervisor({ home: join(tmp, 'nowhere'), dataDir: join(tmp, 'missing') });
  await assert.rejects(sup.start(), (e) => e.code === 'ESTOREDOWN' && /nowhere/.test(e.message));
  assert.equal(sup.status.state, 'down');
  assert.equal(sup.status.cause, 'binary-missing');
});

test('a port another process holds fails the start as port-taken', async () => {
  const blocker = createServer();
  await new Promise((ok) => blocker.listen(0, '127.0.0.1', ok));
  const port = /** @type {import('node:net').AddressInfo} */ (blocker.address()).port;
  const sup = new RedisSupervisor({ home: HOME, dataDir: join(tmp, 'taken'), port });
  try {
    await assert.rejects(sup.start(), (e) => e.code === 'ESTOREDOWN');
    assert.equal(sup.status.cause, 'port-taken');
    assert.match(sup.status.message, new RegExp(`port ${port}`));
  } finally {
    await sup.stop();
    blocker.close();
  }
});

test('a child that dies is reported, restarted, and keeps what it had written', async () => {
  const sup = new RedisSupervisor({ home: HOME, dataDir: join(tmp, 'dies'), restartMs: 50 });
  await sup.start();
  try {
    const c = await sup.client();
    await c.call('SET', 'kept', 'yes');
    await c.call('WAITAOF', 1, 0, 2000);
    c.close();
    const seen = [];
    sup.on('status', (s) => seen.push(s.state === 'down' ? `down:${s.cause}` : s.state));
    sup.child?.kill('SIGKILL');
    await until(sup, (s) => s.state === 'running' && seen.includes('down:died'), 'the restart');
    assert.deepEqual(seen.slice(0, 1), ['down:died']);
    const again = await sup.client();
    assert.equal(await again.call('GET', 'kept'), 'yes');
    again.close();
  } finally {
    await sup.stop();
  }
});

test('a corrupt append-only file fails the start as corrupt-aof, and isn’t restarted over', async () => {
  const dataDir = join(tmp, 'corrupt');
  const first = new RedisSupervisor({ home: HOME, dataDir });
  await first.start();
  const c = await first.client();
  await c.call('SET', 'a', '1');
  c.close();
  await first.stop();
  const aofDir = join(dataDir, 'redis', 'data', 'appendonly');
  const incr = (await readdir(aofDir)).find((n) => n.endsWith('.incr.aof'));
  await appendFile(join(aofDir, String(incr)), 'garbage that isn’t a command\r\n*1\r\n$4\r\nPING\r\n');
  const sup = new RedisSupervisor({ home: HOME, dataDir, restartMs: 50 });
  try {
    await assert.rejects(sup.start(), (e) => e.code === 'ESTOREDOWN');
    assert.equal(sup.status.cause, 'corrupt-aof');
    await new Promise((ok) => setTimeout(ok, 200));
    assert.equal(sup.status.cause, 'corrupt-aof', 'not restarted into the same failure');
  } finally {
    await sup.stop();
  }
});

test('stop() shuts the child down cleanly: it exits, its port is free, and its status is stopped', async () => {
  const sup = new RedisSupervisor({ home: HOME, dataDir: join(tmp, 'stops') });
  await sup.start();
  const { port } = sup;
  const child = sup.child;
  await sup.stop();
  assert.equal(sup.status.state, 'stopped');
  assert.notEqual(child?.exitCode ?? child?.signalCode, null);
  const probe = createServer();
  await new Promise((ok, fail) => probe.once('error', fail).listen(port, '127.0.0.1', ok));
  probe.close();
  assert.match(await readFile(join(tmp, 'stops', 'redis', 'logs', 'redis.log'), 'utf8'), /ready to exit, bye bye/i);
});

test('the build’s files are found in a Postbox package and in a Redis source tree, and named when missing', () => {
  assert.ok(redisFiles(HOME).server.endsWith('redis-server'));
  assert.throws(
    () => redisFiles(join(tmp, 'nowhere')),
    (e) => e.code === 'ENOENT' && /redis-server/.test(e.message),
  );
});

test('when Postbox’s process exits, its Redis child goes with it', async () => {
  const sup = fileURLToPath(new URL('../../server/redis-supervisor.mjs', import.meta.url));
  const script = `import { RedisSupervisor } from ${JSON.stringify(sup)};
    const s = new RedisSupervisor({ home: ${JSON.stringify(HOME)}, dataDir: ${JSON.stringify(join(tmp, 'exits'))} });
    await s.start();
    console.log(s.child.pid);
    process.exit(0);`;
  const node = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 20000 });
  let out = '';
  node.stdout.on('data', (c) => {
    out += c;
  });
  await new Promise((ok) => node.on('exit', ok));
  const pid = Number(out.trim());
  assert.ok(pid > 0, out);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false; // ESRCH: the child is gone
    }
  };
  for (let i = 0; i < 100 && alive(); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(alive(), false);
});
