// What a start does with a Redis already running on its data folder (#508’s requirements, SR-6; server/redis-owner.mjs):
// a leftover from a Postbox that was killed is shut down and the start recovers; one another live Postbox runs is left
// alone; anything it can’t tell is refused with the reason. These run real processes, like the other specs here.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RedisSupervisor } from '../../server/redis-supervisor.mjs';

const HOME = process.env.POSTBOX_REDIS_HOME;
if (!HOME) throw new Error('Set POSTBOX_REDIS_HOME to a Redis 8 build with the JSON and search modules (tests/AGENTS.md, “The store’s Redis”).');

let tmp;
before(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pb-redis-own-')));
});
after(() => rm(tmp, { recursive: true, force: true }));

/** Starts a supervisor in another Node process, as another Postbox would; resolves with it and its child’s pid. */
async function otherPostbox(dataDir) {
  const sup = fileURLToPath(new URL('../../server/redis-supervisor.mjs', import.meta.url));
  const script = `import { RedisSupervisor } from ${JSON.stringify(sup)};
    const s = new RedisSupervisor({ home: ${JSON.stringify(HOME)}, dataDir: ${JSON.stringify(dataDir)} });
    await s.start();
    console.log(s.child.pid);
    setInterval(() => {}, 1000);`;
  const node = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const redisPid = await new Promise((ok, fail) => {
    let out = '';
    node.stdout.on('data', (c) => {
      out += c;
      if (out.includes('\n')) ok(Number(out.trim()));
    });
    node.once('exit', () => fail(new Error(`the other Postbox exited: ${out}`)));
  });
  return { node, redisPid };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('SR-6: after Postbox is killed (SIGKILL), the next start shuts its leftover Redis down and recovers within its bound', async () => {
  const dataDir = join(tmp, 'sr6-killed');
  const { node, redisPid } = await otherPostbox(dataDir);
  node.kill('SIGKILL');
  await new Promise((ok) => node.once('exit', ok));
  assert.ok(alive(redisPid), 'its Redis outlived it');
  const sup = new RedisSupervisor({ home: HOME, dataDir });
  const t0 = Date.now();
  await sup.start();
  try {
    assert.ok(Date.now() - t0 < 8000, `recovered in ${Date.now() - t0} ms`);
    for (let i = 0; i < 100 && alive(redisPid); i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(alive(redisPid), false, 'the leftover is gone');
    assert.notEqual(sup.child?.pid, redisPid);
  } finally {
    await sup.stop();
  }
});

test('SR-6: a Redis another live Postbox runs is left alone, and the start refuses with the reason', async () => {
  const dataDir = join(tmp, 'sr6-live');
  const { node, redisPid } = await otherPostbox(dataDir);
  try {
    const sup = new RedisSupervisor({ home: HOME, dataDir });
    await assert.rejects(sup.start(), (e) => e.code === 'ESTOREDOWN');
    assert.equal(sup.status.state === 'down' && sup.status.cause, 'owned');
    assert.match(/** @type {any} */ (sup.status).message, new RegExp(`process ${node.pid}`));
    assert.equal(sup.child, null, 'nothing was started');
    await new Promise((ok) => setTimeout(ok, 200));
    assert.ok(alive(redisPid), 'the other Postbox’s Redis still runs');
    await sup.stop();
  } finally {
    node.kill('SIGKILL');
    await new Promise((ok) => node.once('exit', ok));
    // Its Redis outlived it: a start now recovers it, and stops it.
    const cleanup = new RedisSupervisor({ home: HOME, dataDir });
    await cleanup.start();
    await cleanup.stop();
  }
});

test('SR-6: something else answering on the store’s socket is ambiguous: the start refuses with the reason and leaves it alone', async () => {
  const sup = new RedisSupervisor({ home: HOME, dataDir: join(tmp, 'sr6-ambiguous') });
  const path = /** @type {string} */ (sup.socket);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  mkdirSync(join(tmp, 'sr6-ambiguous', 'redis'), { recursive: true });
  const seen = [];
  const other = createServer((s) => {
    seen.push('connection');
    s.on('data', () => s.write('-ERR not Redis\r\n'));
  });
  await new Promise((ok) => other.listen(path, ok));
  try {
    for (const owner of [null, { pid: 999999, secret: 'not-its' }]) {
      if (owner) writeFileSync(join(tmp, 'sr6-ambiguous', 'redis', 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
      await assert.rejects(sup.start(), (e) => e.code === 'ESTOREDOWN');
      assert.equal(sup.status.state === 'down' && sup.status.cause, 'owned');
      assert.equal(sup.child, null);
      assert.ok(other.listening, 'it is left alone');
      assert.ok(statSync(path).isSocket(), 'its socket is left alone');
    }
  } finally {
    await sup.stop();
    await new Promise((ok) => other.close(ok));
  }
});
