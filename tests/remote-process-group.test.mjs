// process-group.mjs’s remote branch (#120): Stop for a remote child sends the daemon’s stop and never reaches the
// local kill or ps.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { signalGroup, stopJobUnder, stopTurn } from '../server/adapters/process-group.mjs';
import { RemoteProcess, remoteSpawn } from '../server/remote/process.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { connectTo, FOLDER, sent, until, watch } from './remote-process-fixtures.mjs';

// ── process-group.mjs’s remote branch ─────────────────────────────────────────────────

/** A local kill and ps that fail the test if they’re ever called, and record it: above all kill(-pid, …). */
function forbidden() {
  const calls = [];
  return {
    calls,
    kill: (pid, sig) => {
      calls.push(['kill', pid, sig]);
      throw new Error(`The local kill was called with ${pid}, ${sig}${pid < 0 ? ', a process group on the laptop' : ''}.`);
    },
    list: async () => {
      calls.push(['list']);
      throw new Error('The local ps was read for a remote turn.');
    },
  };
}

test('#120: stopTurn on a remote child sends the daemon’s stop, resolves gone at ended, and never calls the local kill or ps', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const child = remoteSpawn({ connection: connectTo(d), harness: 'claude-code', folder: FOLDER, stdin: 'none', turn: 'ts' })('claude', []);
  const w = watch(child);
  await until(() => sent(d, 'read').length === 1, 'the read');
  const f = forbidden();
  const exited = new Promise((r) => child.once('exit', r));
  const { kept, gone } = await stopTurn(child, { keep: [{ id: 'job1', command: 'sleep 100' }], exited, kill: f.kill, list: f.list, graceMs: 5, pollMs: 1 });
  assert.deepEqual(kept, [], 'no job is kept for a remote turn');
  await gone;
  await w.close;
  await new Promise((r) => setTimeout(r, 20)); // past the grace period a local stop would use
  assert.deepEqual(f.calls, []);
  assert.deepEqual(d.stops, ['ts']);
  assert.equal(child.signalCode, 'SIGINT');
  // A turn already ended: gone at once, and still nothing local.
  assert.deepEqual(f.calls, []);
  await (await stopTurn(child, { exited, kill: f.kill, list: f.list })).gone;
  assert.equal(sent(d, 'stop').length, 1);
  assert.deepEqual(f.calls, []);
});

test('#120: signalGroup and stopJobUnder on a remote child: the daemon’s stop, and a job’s own Stop isn’t offered', async () => {
  const f = forbidden();
  const child = new RemoteProcess(
    new (class extends EventEmitter {
      send() {
        return true;
      }
    })(),
    { turn: 'tj', from: 0 },
  );
  // A host process ID, were one ever set, must still never reach the local kill.
  Object.defineProperty(child, 'pid', { value: 4242 });
  assert.equal(signalGroup(child, 'SIGKILL', f.kill), true);
  assert.equal(child.killed, true);
  assert.equal(await stopJobUnder(child, { command: 'sleep 100' }, { kill: f.kill, list: f.list }), false);
  const { gone } = await stopTurn(child, { exited: new Promise(() => {}), kill: f.kill, list: f.list, graceMs: 1, pollMs: 1 });
  child.finish({ code: null, signal: 'SIGINT' });
  await gone;
  assert.deepEqual(f.calls, []);
});
