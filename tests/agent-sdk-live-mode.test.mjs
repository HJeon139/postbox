// A permission mode changed while an Agent SDK turn runs (#66, #371, #817, #806). A turn loads the person’s hooks when it
// starts, in every mode but Ask me and Accept edits (settingsFor in server/adapters/setup.mjs); in those two Postbox
// turns hooks off, since a hook that approves a call would skip their ask rules for writes outside Postbox and the
// card. So a turn that started with hooks on doesn’t switch live into Ask me or Accept edits: the hooks it loaded would
// keep running where the panel says they don’t. And a turn started in bypass, with no permission callback and no ask
// rules for writes outside, keeps bypass. Either keeps its mode until it ends or is stopped, and the runtime lists it
// with the turns that keep their mode. A switch that leaves hooks off, or turns them on, changes live. The Claude
// Code CLI can’t change a running turn’s mode at all.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AgentSdkAdapter, liveControl } from '../server/adapters/agent-sdk.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { sleep } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await sleep(2);
  assert.ok(fn(), `Timed out waiting for ${label}`);
};

/** A running query that records each mode the adapter sets on it. */
const query = () => {
  const modes = [];
  return { modes, setPermissionMode: async (m) => modes.push(m) };
};

test('#817: an Agent SDK turn started in bypass keeps it: leaving bypass is refused, and the query isn’t changed', async () => {
  const q = query();
  const live = liveControl(q, 'bypass');
  assert.equal(await live.setPermissionMode('ask'), false);
  assert.equal(await live.setPermissionMode('auto'), false);
  assert.equal(await live.setPermissionMode('acceptEdits'), false);
  assert.deepEqual(q.modes, []);
  assert.equal(await live.setPermissionMode('bypass'), true);
  assert.deepEqual(q.modes, ['bypassPermissions']);
});

test('#817: an Agent SDK turn started outside bypass still changes live, into bypass and back out', async () => {
  const q = query();
  const live = liveControl(q, 'ask');
  assert.equal(await live.setPermissionMode('bypass'), true);
  assert.equal(await live.setPermissionMode('auto'), true);
  assert.deepEqual(q.modes, ['bypassPermissions', 'auto']);
});

// Each mode a turn can start in, with whether its hooks loaded (on), and each mode it can be switched to live.
const STARTS = [
  ['auto', true],
  ['ask', false],
  ['acceptEdits', false],
  ['plan', true],
  ['not-a-mode', true],
];
const SDK_MODE = { auto: 'auto', ask: 'default', acceptEdits: 'acceptEdits', bypass: 'bypassPermissions' };

test('#806: a turn that loaded hooks doesn’t switch live into Ask me or Accept edits; every other live switch from a non-bypass start takes effect', async () => {
  for (const [started, hooksOn] of STARTS) {
    for (const mode of ['auto', 'ask', 'acceptEdits', 'bypass']) {
      const q = query();
      const takes = !(hooksOn && (mode === 'ask' || mode === 'acceptEdits'));
      const label = `started ${started}, switched to ${mode}`;
      assert.equal(await liveControl(q, started).setPermissionMode(mode), takes, label);
      assert.deepEqual(q.modes, takes ? [SDK_MODE[mode]] : [], label);
    }
  }
});

test('#806: a live control told nothing about its start treats the turn as Auto, so a switch to Ask me waits', async () => {
  const q = query();
  const live = liveControl(q);
  assert.equal(await live.setPermissionMode('ask'), false);
  assert.equal(await live.setPermissionMode('acceptEdits'), false);
  assert.deepEqual(q.modes, []);
});

test('#806: once a turn that started in Ask me has switched to Auto, switching back to Ask me still takes effect', async () => {
  const q = query();
  const live = liveControl(q, 'ask');
  assert.equal(await live.setPermissionMode('auto'), true);
  assert.equal(await live.setPermissionMode('ask'), true);
  assert.deepEqual(q.modes, ['auto', 'default']);
});

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

test('#817: the Agent SDK adapter hands over a live control that knows its turn started in bypass', async () => {
  const q = query();
  const sdk = {
    query({ options }) {
      const run = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
        await new Promise((r) => options.abortController.signal.addEventListener('abort', r));
      })();
      return Object.assign(run, { setPermissionMode: q.setPermissionMode });
    },
  };
  const adapter = new AgentSdkAdapter({ sdk, workRoot: tempDir('pb-live-mode-work-'), listProcesses: async () => [] });
  const ctx = fakeCtx('bypass');
  const done = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx).catch(() => {});
  await until(() => ctx.calls.control, 'the live control');
  assert.equal(await ctx.calls.control.setPermissionMode('ask'), false);
  assert.equal(await ctx.calls.control.setPermissionMode('auto'), false, 'a control that took the turn for Auto would let this through');
  assert.deepEqual(q.modes, []);
  ctx.abort.abort();
  await done;
});

test('#806: the Agent SDK adapter hands over a live control that knows its turn started in Ask me, so Accept edits changes it now', async () => {
  const q = query();
  const sdk = {
    query({ options }) {
      const run = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
        await new Promise((r) => options.abortController.signal.addEventListener('abort', r));
      })();
      return Object.assign(run, { setPermissionMode: q.setPermissionMode });
    },
  };
  const adapter = new AgentSdkAdapter({ sdk, workRoot: tempDir('pb-live-mode-work-'), listProcesses: async () => [] });
  const ctx = fakeCtx('ask');
  const done = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx).catch(() => {});
  await until(() => ctx.calls.control, 'the live control');
  assert.equal(await ctx.calls.control.setPermissionMode('acceptEdits'), true);
  assert.deepEqual(q.modes, ['acceptEdits']);
  ctx.abort.abort();
  await done;
});

test('#806: the Agent SDK adapter hands over a live control that knows its turn started in Auto, or in no mode', async () => {
  for (const permissionMode of ['auto', undefined]) {
    const q = query();
    const sdk = {
      query({ options }) {
        const run = (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
          await new Promise((r) => options.abortController.signal.addEventListener('abort', r));
        })();
        return Object.assign(run, { setPermissionMode: q.setPermissionMode });
      },
    };
    const adapter = new AgentSdkAdapter({ sdk, workRoot: tempDir('pb-live-mode-work-'), listProcesses: async () => [] });
    const ctx = fakeCtx(permissionMode);
    const done = adapter.deliver({}, { kind: 'user', text: 'Go' }, ctx).catch(() => {});
    await until(() => ctx.calls.control, 'the live control');
    assert.equal(await ctx.calls.control.setPermissionMode('ask'), false, `started in ${permissionMode}`);
    assert.equal(await ctx.calls.control.setPermissionMode('bypass'), true, `started in ${permissionMode}`);
    assert.deepEqual(q.modes, ['bypassPermissions'], `started in ${permissionMode}`);
    ctx.abort.abort();
    await done;
  }
});

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
