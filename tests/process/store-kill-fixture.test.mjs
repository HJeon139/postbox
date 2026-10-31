// How the store’s tests kill the Redis child (tests/store-kill-fixture.mjs). Once the child runs, nothing of it keeps
// Postbox’s event loop alive: the supervisor unrefs the child and its pipes, and an idle connection is unref’d too
// (server/redis-supervisor.mjs, server/redis-client.mjs). So a test that kills the child and awaits only its exit has
// an empty loop, and Node exits before the kernel reports the death; every test still pending is then cancelled with
// “Promise resolution is still pending but the event loop has already resolved” and no cause. CI’s Linux runners
// report the death late enough for that every time; a macOS test file is kept alive by the runner, so it passed there.
// The fixture’s wait holds the loop until the supervisor has reported the death, or fails naming its status.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

if (!process.env.POSTBOX_REDIS_HOME) throw new Error('Set POSTBOX_REDIS_HOME (tests/AGENTS.md, “The store’s Redis”).');

const CHILD = fileURLToPath(new URL('./store-kill-child.mjs', import.meta.url));
const RECOVERY = fileURLToPath(new URL('./store-recovery-child.mjs', import.meta.url));
const dirs = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Runs a child script in a Node of its own, up to 20 s. @param {string} script @param {string[]} args */
async function run(script, ...args) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-store-kill-'));
  dirs.push(dataDir);
  const node = spawn(process.execPath, [script, dataDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  node.stdout.on('data', (c) => (out += c));
  node.stderr.on('data', (c) => (out += c));
  const exited = new Promise((ok) => node.once('exit', (code, signal) => ok({ code, signal })));
  const timeout = new Promise((ok) => setTimeout(() => ok(null), 20_000));
  const how = await Promise.race([exited, timeout]);
  if (!how) node.kill('SIGKILL');
  assert.ok(how, `the Node didn’t exit within 20 s:\n${out}`);
  return { how, out };
}

test('a Node whose only wait is a store’s killed child stays up until the supervisor reports it, restarts it, and writes reopen', async () => {
  const { how, out } = await run(CHILD);
  assert.doesNotMatch(out, /unsettled top-level await|event loop has already resolved/, `Node exited with the wait still pending:\n${out}`);
  assert.deepEqual(how, { code: 0, signal: null }, `the Node exited ${how.code ?? how.signal}:\n${out}`);
  assert.match(out, /^DOWN down$/m, `the supervisor reported the child down:\n${out}`);
  assert.match(out, /^WRITABLE true$/m, `writes reopened after the restart:\n${out}`);
  assert.match(out, /^WRITTEN t,u$/m, `the write after the restart landed:\n${out}`);
});

// CI run 41106275069 cancelled tests/store-recovery.test.mjs this way: a commit’s reply lost, the child killed, and the
// test awaiting a gate on the restarted child’s catch-up with nothing ref’d. The restart is put after the catch-up’s
// backoff, as Linux’s late report of the death does, so the loop empties between them.
test('a Node whose only wait is a gate on a restarted child’s catch-up stays up through `holding`, and the catch-up reopens writes', async () => {
  const { how, out } = await run(RECOVERY, 'held', '600');
  assert.doesNotMatch(out, /unsettled top-level await|event loop has already resolved/, `Node exited with the wait still pending:\n${out}`);
  assert.deepEqual(how, { code: 0, signal: null }, `the Node exited ${how.code ?? how.signal}:\n${out}`);
  assert.match(out, /^REFUSED ESTOREDOWN$/m, `the commit whose reply was lost was refused:\n${out}`);
  assert.match(out, /^HIT down:reconciling$/m, `catch-up reached its first read with writes closed:\n${out}`);
  assert.match(out, /^WRITABLE true ab$/m, `writes reopened with the lost commit read back:\n${out}`);
});
