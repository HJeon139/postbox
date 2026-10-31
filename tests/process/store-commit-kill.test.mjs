// A commit survives, whole or not at all, a SIGKILL of the Postbox writing it (#508’s PR 1a; tests/store-commit.test.mjs
// cuts the line at every byte without a process). A Node of its own (tests/process/store-commit-child.mjs) commits
// three events with an fsync that never returns, and is killed there: the store that loads the folder next has all three
// or none, the commit never resolved, and the lock the killed process left is stale and taken over.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../../server/store.mjs';
import { holding, killed } from '../store-kill-fixture.mjs';

const CHILD = fileURLToPath(new URL('./store-commit-child.mjs', import.meta.url));
const dirs = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Starts the child on a data folder of its own and resolves once it has said `text`, or fails with what it said. @param {string} text */
async function childSaying(text) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-commit-kill-'));
  dirs.push(dataDir);
  const child = spawn(process.execPath, [CHILD, dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const said = new Promise((ok, fail) => {
    const look = () => out.includes(text) && ok(undefined);
    child.stdout.on('data', look);
    child.once('exit', (code, signal) => fail(new Error(`the child exited (${code ?? signal}) before saying ${text}:\n${out}`)));
  });
  try {
    await holding(said, `the child to say ${text}`, 10_000);
  } catch (e) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw e;
  }
  return { child, dataDir, out: () => out };
}

test('a store SIGKILLed while its commit’s fsync is pending leaves a log that loads with all of the commit or none, and a stale lock', async () => {
  const { child, dataDir, out } = await childSaying('SYNCING');
  const how = await killed(child);
  assert.equal(how.signal, 'SIGKILL', `killed, not exited: ${JSON.stringify(how)}`);
  assert.doesNotMatch(out(), /COMMITTED/, `the commit resolved before its fsync:\n${out()}`);
  assert.equal(await readFile(join(dataDir, 'store.lock'), 'utf8'), String(child.pid), 'the killed process left its lock');
  const s = await new Store(dataDir).load();
  const threads = Object.keys(s.state.threads).sort();
  assert.ok(
    (s.state.seq === 1 && threads.length === 1) || (s.state.seq === 4 && threads.join() === 't0,t1,t2' && s.state.items.t1?.[0]?.text === 'hi'),
    `the store loaded seq ${s.state.seq} with threads ${threads.join()}: part of a commit`,
  );
  assert.equal(await readFile(join(dataDir, 'store.lock'), 'utf8'), String(process.pid), 'the stale lock was taken over');
  s.emit('thread', { id: 'after', members: [] });
  await s.flush();
  await s.close();
  const again = await new Store(dataDir).load();
  assert.ok(again.state.threads.after, 'writes go on cleanly after the kill');
  await again.close();
});
