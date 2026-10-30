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
const dirs = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test('a Node whose only wait is a store’s killed child stays up until the supervisor reports it, restarts it, and writes reopen', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-store-kill-'));
  dirs.push(dataDir);
  const node = spawn(process.execPath, [CHILD, dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  node.stdout.on('data', (c) => (out += c));
  node.stderr.on('data', (c) => (out += c));
  const exited = new Promise((ok) => node.once('exit', (code, signal) => ok({ code, signal })));
  const timeout = new Promise((ok) => setTimeout(() => ok(null), 20_000));
  const how = await Promise.race([exited, timeout]);
  if (!how) node.kill('SIGKILL');
  assert.ok(how, `the Node didn’t exit within 20 s:\n${out}`);
  assert.doesNotMatch(out, /unsettled top-level await|event loop has already resolved/, `Node exited with the wait still pending:\n${out}`);
  assert.deepEqual(how, { code: 0, signal: null }, `the Node exited ${how.code ?? how.signal}:\n${out}`);
  assert.match(out, /^DOWN down$/m, `the supervisor reported the child down:\n${out}`);
  assert.match(out, /^WRITABLE true$/m, `writes reopened after the restart:\n${out}`);
  assert.match(out, /^WRITTEN t,u$/m, `the write after the restart landed:\n${out}`);
});
