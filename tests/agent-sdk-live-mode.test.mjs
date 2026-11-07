// A permission mode changed while an Agent SDK turn runs (#66, #371, #817). A turn started in bypass loaded the
// person’s hooks, with no permission callback and no ask rules for writes outside Postbox; switching its mode live would
// leave those hooks running while the panel says they don’t. So it keeps bypass until it ends or is stopped, and the
// runtime lists it with the turns that keep their mode. The Claude Code CLI can’t change a running turn’s mode at all.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AgentSdkAdapter, liveControl } from '../server/adapters/agent-sdk.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';
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

test('#817: leaving bypass during a bypass turn lists its session as keeping its mode, not as changed now', async () => {
  const { rt, adapter, t, a, alpha } = setup();
  rt.updatePersona(a.id, { permissionMode: 'bypass' });
  const q = query();
  const h = held();
  adapter.next.push(async (ctx) => {
    ctx.control(liveControl(q, ctx.persona.permissionMode));
    await h.step(ctx);
  });
  rt.sendMessage(t.id, { text: '@alpha run the tests' });
  await sleep(5);
  assert.deepEqual(await rt.setPermissionMode(a.id, 'ask'), { ok: true, now: [], later: [alpha.id] });
  assert.deepEqual(q.modes, [], 'the running turn keeps bypass, so its hooks and its mode agree until it ends');
  assert.equal(rt.persona(a.id).permissionMode, 'ask', 'the persona changes at once, for its next turns');
  h.release();
  await settle(rt);
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
  assert.deepEqual(q.modes, []);
  ctx.abort.abort();
  await done;
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
