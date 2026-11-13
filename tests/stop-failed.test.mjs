// A stop that fails still ends the turn (#126): the session isn’t left stopping, and the rejection doesn’t float to
// bring Postbox down. No real processes: spawn, ps and kill are fakes, as in tests/stop.test.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { parsePs } from '../server/adapters/process-group.mjs';
import { exitedGroups, fakeKill, STOP_DIR } from './stop-fixture.mjs';

const PS = parsePs(readFileSync(new URL('fixtures/claude-code/background-ps.txt', import.meta.url), 'utf8'));
const CLI = 69116;
const JOB = { id: 'bm2939coh', command: "sleep 170; echo 'pbx C'" };

/** Waits for check() to hold, looking every 5 ms, however slow the runner: the test’s own timeout bounds it. */
async function until(check) {
  while (!check()) await new Promise((r) => setTimeout(r, 5));
}

/** A turn’s context whose store refuses the kept job’s record. @param {AbortSignal} signal */
function refusingCtx(signal) {
  return {
    signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=se_1&turn=t1',
    persona: { handle: 'developer', model: 'claude-opus-5-5', permissionMode: 'auto', folder: `${STOP_DIR}/dev` },
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
}

// A turn that never ends fails on this test’s timeout, not on a wall-clock budget a slow runner can miss.
test('#126: a stop whose kept job can’t be reported still ends the turn, once the CLI has exited, and says why', { timeout: 30_000 }, async (t) => {
  let spawned = false;
  const child = Object.assign(new EventEmitter(), { pid: CLI, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  child.kill = () => true;
  const k = fakeKill();
  const adapter = new ClaudeCodeAdapter({
    bin: 'claude',
    workRoot: '/tmp/pb-test-work',
    spawnImpl: /** @type {any} */ (
      () => {
        spawned = true;
        return child;
      }
    ),
    kill: k.kill,
    listProcesses: async () => PS,
  });
  const abort = new AbortController();
  const ctx = refusingCtx(abort.signal);
  const logged = t.mock.method(console, 'error', () => {});
  const ended = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx).then(
    () => 'ended',
    (e) => `failed: ${e.message}`,
  );
  await until(() => spawned);
  abort.abort({ keepJobs: [JOB] });
  // The stop has killed the CLI’s group (the kept job’s is spared), and waits for the CLI to exit.
  await until(() => k.sent.some(([pid]) => pid === -CLI));
  exitedGroups.add(-CLI);
  child.stdout.end();
  child.emit('exit', null, 'SIGKILL');
  setImmediate(() => child.emit('close', null));
  // Ended, or failed with the store’s refusal: either way it’s over, not left stopping.
  assert.match(await ended, /^(ended|failed: )/);
  assert.ok(
    logged.mock.calls.some((c) => String(c.arguments[0]).includes('the store refused the write')),
    'the failed stop says why',
  );
});
