// A permission mode changed while a turn runs (#66, #371, #817): the Claude Code CLI can’t change a running turn’s mode,
// so its adapter hands over no control for one, and the change applies from the agent’s next turn.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { sleep } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await sleep(2);
  assert.ok(fn(), `Timed out waiting for ${label}`);
};

/** A turn context that keeps what the adapter hands over as its live control. */
function fakeCtx(permissionMode) {
  const abort = new AbortController();
  const calls = { control: null };
  return {
    calls,
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=se_1&turn=t1',
    persona: { handle: 'developer', model: 'claude-opus-5-5', permissionMode, folder: tempDir('pb-live-mode-') },
    project: null,
    handles: ['developer'],
    state: {},
    saveState() {},
    pathOf: () => null,
    text() {},
    activity() {},
    status() {},
    compaction() {},
    job() {},
    control: (c) => {
      calls.control = c;
    },
  };
}

test('#817: the Claude Code CLI hands over no live mode change, so a running CLI turn always keeps its mode', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  child.kill = () => {};
  const adapter = new ClaudeCodeAdapter({
    bin: 'claude',
    workRoot: tempDir('pb-live-mode-work-'),
    spawnImpl: /** @type {any} */ (() => child),
    kill: () => true,
    listProcesses: async () => [],
  });
  const ctx = fakeCtx('bypass');
  const done = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx).catch(() => {});
  await until(() => ctx.calls.control, 'the live control');
  assert.deepEqual(Object.keys(ctx.calls.control), ['stopJob']);
  child.stdout.end();
  child.emit('exit', 0, null);
  child.emit('close', 0);
  await done;
});
