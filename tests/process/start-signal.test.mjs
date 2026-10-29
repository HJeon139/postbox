// SR-6, a clean shutdown: a Postbox stopped with SIGTERM or SIGINT while it starts leaves no Redis child running and no
// claim on its data folder behind, and exits soon (review on #525: its signal handlers came only after the start, so
// a signal during the start killed Postbox and left the Redis child it had spawned running). Each test starts a real
// Postbox (tests/process/start-signal-child.mjs) on a data folder of its own and signals it at one moment of its start.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

if (!process.env.POSTBOX_REDIS_HOME)
  throw new Error('Set POSTBOX_REDIS_HOME to a Redis 8 build with the JSON and search modules (tests/AGENTS.md, “The store’s Redis”).');

const CHILD = fileURLToPath(new URL('start-signal-child.mjs', import.meta.url));
const skip = process.platform === 'win32';

let tmp;
before(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pb-start-signal-')));
});
after(() => rm(tmp, { recursive: true, force: true }));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The claims on the data folder: its Redis’s (server/redis-owner.mjs) and the folder’s own lock (server/home.mjs). */
const claims = (dataDir) => {
  const dir = join(dataDir, 'redis', 'claims');
  return [...(existsSync(dir) ? readdirSync(dir) : []), ...(existsSync(join(dataDir, 'postbox.lock')) ? ['postbox.lock'] : [])];
};

/**
 * Starts a Postbox that reports `moment`, then sends it `signals`, `gap` ms apart. Resolves with how it exited, how
 * long after the first signal, what it said, and its Redis child’s pid when it had one.
 */
async function signalAt(t, name, moment, signals, gap = 300) {
  const dataDir = join(tmp, name);
  const node = spawn(process.execPath, [CHILD, dataDir, moment], {
    env: { ...process.env, POSTBOX_BACKENDS: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  node.stdout.on('data', (c) => (out += c));
  node.stderr.on('data', (c) => (out += c));
  const exited = new Promise((ok) => node.once('exit', (code, signal) => ok({ code, signal })));
  let redisPid;
  try {
    const at = await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`Postbox didn’t reach “${moment}” in 15 s:\n${out}`)), 15_000);
      const look = () => {
        const m = out.match(new RegExp(`AT ${moment}[^\\n]*\\n`));
        if (!m) return;
        clearTimeout(timer);
        ok(m[0]);
      };
      node.stdout.on('data', look);
      exited.then(() => fail(new Error(`Postbox exited before “${moment}”:\n${out}`)));
    });
    redisPid = Number(at.match(/REDIS_PID=(\d+)/)?.[1]) || undefined;
    const t0 = Date.now();
    for (const [i, s] of signals.entries()) {
      if (i) await new Promise((ok) => setTimeout(ok, gap));
      node.kill(s);
    }
    const timeout = new Promise((ok) => setTimeout(() => ok(null), 10_000));
    const how = await Promise.race([exited, timeout]);
    assert.ok(how, `Postbox didn’t exit within 10 s of ${signals.join(', then ')}:\n${out}`);
    return { ...how, ms: Date.now() - t0, at, out, redisPid, dataDir };
  } finally {
    if (node.exitCode === null && node.signalCode === null) {
      node.kill('SIGKILL');
      await exited;
    }
    // After the test’s checks: a child left running fails them, and then doesn’t outlive the test.
    t.after(() => {
      if (redisPid && alive(redisPid)) process.kill(redisPid, 'SIGKILL');
    });
  }
}

test('SIGTERM before the Redis child is spawned: no child is ever spawned, the claims go, and Postbox exits 143', { skip }, async (t) => {
  const r = await signalAt(t, 'before-spawn', 'before-spawn', ['SIGTERM']);
  assert.match(r.at, /child=none/, 'no child yet when the signal came');
  assert.ok(r.ms < 4000, `exited after ${r.ms} ms`);
  assert.equal(existsSync(join(r.dataDir, 'redis', 'redis.conf')), false, 'the start stopped before it wrote its config');
  assert.deepEqual(claims(r.dataDir), []);
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 143, signal: null }, r.out);
});

test('SIGTERM after the Redis child is spawned and before it is ready: the child is stopped, the claims go, and Postbox exits 143', { skip }, async (t) => {
  const r = await signalAt(t, 'spawned', 'spawned', ['SIGTERM']);
  assert.match(r.at, /state=starting/, 'the child hadn’t said it was ready');
  assert.ok(r.redisPid, r.at);
  assert.ok(r.ms < 4000, `exited after ${r.ms} ms`);
  assert.equal(alive(r.redisPid), false, 'the Redis child is gone when Postbox exits');
  assert.deepEqual(claims(r.dataDir), []);
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 143, signal: null }, r.out);
});

test('SIGINT after the Redis child is spawned and before it is ready: the same, and Postbox exits 130', { skip }, async (t) => {
  const r = await signalAt(t, 'spawned-int', 'spawned', ['SIGINT']);
  assert.ok(r.ms < 4000, `exited after ${r.ms} ms`);
  assert.equal(alive(r.redisPid), false, 'the Redis child is gone when Postbox exits');
  assert.deepEqual(claims(r.dataDir), []);
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 130, signal: null }, r.out);
});

test('SIGTERM once the Redis child is ready and the rest of the start never finishes: the child is stopped, the claims go', { skip }, async (t) => {
  const r = await signalAt(t, 'ready', 'ready', ['SIGTERM']);
  assert.match(r.at, /state=running/);
  assert.ok(r.ms < 4000, `exited after ${r.ms} ms`);
  assert.equal(alive(r.redisPid), false, 'the Redis child is gone when Postbox exits');
  assert.deepEqual(claims(r.dataDir), []);
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 143, signal: null }, r.out);
});

test('a second signal during the start exits at once, and the Redis child and the claims still go with Postbox', { skip }, async (t) => {
  const r = await signalAt(t, 'slow-stop', 'slow-stop', ['SIGTERM', 'SIGTERM']);
  assert.ok(r.ms < 2000, `exited ${r.ms} ms after the first signal, though the stop it began takes 30 s`);
  assert.deepEqual(claims(r.dataDir), []);
  // Postbox’s exit sends the child SIGTERM (RedisSupervisor’s killOnExit); Redis then shuts down on its own.
  const t0 = Date.now();
  while (alive(r.redisPid) && Date.now() - t0 < 3000) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(alive(r.redisPid), false, 'the Redis child stopped after Postbox exited');
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 143, signal: null }, r.out);
});

test('a start that fails once its Redis child is ready stops the child, lets go of the claims, and exits 1 with the error', { skip }, async (t) => {
  const r = await signalAt(t, 'fails', 'fails', []);
  assert.match(r.out, /The test refused the store’s first connection/);
  assert.equal(alive(r.redisPid), false, 'the Redis child is gone when Postbox exits');
  assert.deepEqual(claims(r.dataDir), []);
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 1, signal: null }, r.out);
});

test('SIGTERM once Postbox runs closes it as before: the child stops, the claims go, and it exits 0', { skip }, async (t) => {
  const r = await signalAt(t, 'started', 'started', ['SIGTERM']);
  assert.ok(r.redisPid, r.at);
  assert.ok(r.ms < 4000, `exited after ${r.ms} ms`);
  assert.equal(alive(r.redisPid), false, 'the Redis child is gone when Postbox exits');
  assert.deepEqual(claims(r.dataDir), []);
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 0, signal: null }, r.out);
});
