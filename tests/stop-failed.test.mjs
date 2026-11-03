// A stop that fails still ends the turn (#126): the session isn’t left stopping, and the rejection doesn’t float to
// bring Postbox down. No real processes: spawn, ps and kill are fakes, as in tests/stop.test.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { parsePs } from '../server/adapters/process-group.mjs';
import { exitedGroups, fakeKill } from './stop-fixture.mjs';

const PS = parsePs(readFileSync(new URL('fixtures/claude-code/background-ps.txt', import.meta.url), 'utf8'));
const CLI = 69116;
const JOB = { id: 'bm2939coh', command: "sleep 170; echo 'pbx C'" };

test('#126: a stop whose kept job can’t be reported still ends the turn, once the CLI has exited, and says why', async (t) => {
  const child = Object.assign(new EventEmitter(), { pid: CLI, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  child.kill = () => true;
  const k = fakeKill();
  const adapter = new ClaudeCodeAdapter({
    bin: 'claude',
    workRoot: '/tmp/pb-test-work',
    spawnImpl: /** @type {any} */ (() => child),
    kill: k.kill,
    listProcesses: async () => PS,
  });
  const abort = new AbortController();
  const ctx = {
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=se_1&turn=t1',
    persona: { handle: 'developer', model: 'claude-opus-5-5', permissionMode: 'auto', folder: '/tmp/pb-test-dev' },
    project: null,
    handles: ['developer'],
    state: {},
    saveState() {},
    pathOf: () => null,
    text() {},
    activity() {},
    status() {},
    compaction() {},
    control() {},
    // Reporting the kept job is a store write, and a store can refuse one: the stop's promise rejects with it.
    job() {
      throw new Error('the store refused the write');
    },
  };
  const logged = t.mock.method(console, 'error', () => {});
  const ended = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx).then(
    () => 'ended',
    (e) => `failed: ${e.message}`,
  );
  await new Promise((r) => setTimeout(r, 20));
  abort.abort({ keepJobs: [JOB] });
  await new Promise((r) => setTimeout(r, 20));
  exitedGroups.add(-CLI);
  child.stdout.end();
  child.emit('exit', null, 'SIGKILL');
  setImmediate(() => child.emit('close', null));
  const outcome = await Promise.race([ended, new Promise((r) => setTimeout(() => r('still stopping after 2 s'), 2000))]);
  assert.notEqual(outcome, 'still stopping after 2 s');
  assert.ok(
    logged.mock.calls.some((c) => String(c.arguments[0]).includes('the store refused the write')),
    'the failed stop says why',
  );
});
