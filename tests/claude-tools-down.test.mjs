// #1161: Claude Code’s init lists each MCP server with a status. When Postbox’s own server failed, as in the init
// recorded on a host (fixtures/claude-code/host-mcp-init.jsonl), the turn ran with no Postbox tools and no one was
// told. The person now sees a failed step, and the agent hears of it at its next turn, once. The status is read from
// the init alone, so a local run and a host run are alike; the Agent SDK uses the same mapper.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AgentSdkAdapter } from '../server/adapters/agent-sdk.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { MESSAGE_FILE } from '../shared/remote-protocol.mjs';
import { forbidden, remoteCtx, starts } from './claude-code-remote-fixture.mjs';
import { createFakeDaemon, fixtureLines } from './fake-daemon.mjs';
import { tempDir } from './temp-dirs.mjs';

const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const isInit = (e) => e.type === 'system' && e.subtype === 'init';
/** The recorded block turn, its init swapped for the host’s, where Postbox’s server failed. */
const failedTurn = () => {
  const [hostInit] = fixture('host-mcp-init');
  const block = fixture('block');
  return [{ ...hostInit, session_id: block.find(isInit)?.session_id ?? hostInit.session_id }, ...block.filter((e) => !isInit(e))];
};
/** The same init with Postbox’s server connected. */
const fineTurn = () => fixture('block');

function fakeCtx(over = {}) {
  const calls = { text: '', activity: [], saved: {} };
  const abort = new AbortController();
  return {
    calls,
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: tempDir('pb-tools-down-'), description: '', instructions: '' },
    project: null,
    handles: ['coder'],
    state: {},
    saveState(p) {
      Object.assign(calls.saved, p);
      Object.assign(this.state, p);
    },
    pathOf: () => null,
    text: (d) => {
      calls.text += d;
    },
    activity: (a) => calls.activity.push(a),
    status: () => {},
    reported: () => {},
    ...over,
  };
}

/** A stand-in for spawn() that plays one recorded stream per run. @param {(i: number) => any[]} linesOf */
function fakeSpawn(linesOf) {
  const runs = [];
  const spawnImpl = (_bin, args, opts) => {
    const lines = linesOf(runs.length);
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => {} });
    const run = { args, opts, stdin: '' };
    child.stdin.on('data', (d) => {
      run.stdin += d;
    });
    runs.push(run);
    setImmediate(() => {
      for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
      child.stdout.end();
      setTimeout(() => child.emit('close', 0), 10);
    });
    return child;
  };
  return { spawnImpl, runs };
}

/** A stand-in for the Agent SDK that plays one recorded stream per query. @param {(i: number) => any[]} linesOf */
function fakeSdk(linesOf) {
  const calls = [];
  return {
    calls,
    query({ prompt, options }) {
      const lines = linesOf(calls.length);
      calls.push({ prompt, options });
      return (async function* () {
        for (const l of lines) yield l;
      })();
    },
  };
}

/** What a run was sent: Claude Code takes the turn’s message on stdin. */
const promptOf = (run) => run.stdin;
const told = /^\[Postbox\] In your last turn, Postbox’s tool server didn’t start/;

test('#1161 an init that reports Postbox’s server failed is a failed step the person sees, and the reply is kept', () => {
  const ctx = fakeCtx();
  const m = createStreamMapper(ctx, { now: () => 1000 });
  for (const e of failedTurn()) m.push(e);
  const step = ctx.calls.activity.find((a) => a.label === 'Postbox’s tools didn’t load');
  assert.ok(step, 'a step says so');
  assert.equal(step.state, 'failed');
  assert.match(step.detail, /failed/);
  assert.equal(ctx.calls.text, 'Tea or coffee? Pick one above.', 'the reply still streams in');
});

test('#1161 an init with Postbox’s server connected shows no such step', () => {
  const ctx = fakeCtx();
  const m = createStreamMapper(ctx, { now: () => 1000 });
  for (const e of fineTurn()) m.push(e);
  assert.ok(!ctx.calls.activity.some((a) => a.label === 'Postbox’s tools didn’t load'));
});

test('#1161 Claude Code: the next turn is told first that Postbox’s tools didn’t load, and only once', async () => {
  const { spawnImpl, runs } = fakeSpawn((i) => (i === 0 ? failedTurn() : fineTurn()));
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-tools-down-work-'), spawnImpl });
  const ctx = fakeCtx();
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  assert.doesNotMatch(promptOf(runs[0]), told, 'the turn itself isn’t told anything');
  await adapter.deliver({}, { kind: 'user', text: 'Try again.' }, ctx);
  assert.match(promptOf(runs[1]), told, 'the next turn is told first');
  assert.match(promptOf(runs[1]), /Try again\./, 'then its request');
  await adapter.deliver({}, { kind: 'user', text: 'Once more.' }, ctx);
  assert.doesNotMatch(promptOf(runs[2]), told, 'and only once');
});

test('#1161 the Agent SDK: the next turn is told first that Postbox’s tools didn’t load, and only once', async () => {
  const sdk = fakeSdk((i) => (i === 0 ? failedTurn() : fineTurn()));
  const adapter = new AgentSdkAdapter({ sdk, workRoot: tempDir('pb-tools-down-sdk-') });
  const ctx = fakeCtx();
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  assert.ok(
    ctx.calls.activity.some((a) => a.label === 'Postbox’s tools didn’t load'),
    'the step shows here too',
  );
  await adapter.deliver({}, { kind: 'user', text: 'Try again.' }, ctx);
  assert.match(String(sdk.calls[1].prompt), told, 'the next turn is told first');
  await adapter.deliver({}, { kind: 'user', text: 'Once more.' }, ctx);
  assert.doesNotMatch(String(sdk.calls[2].prompt), told, 'and only once');
});

test('#1161 another server failing, with Postbox’s connected, isn’t Postbox’s tools failing', () => {
  const [hostInit] = fixture('host-mcp-init');
  const init = { ...hostInit, mcp_servers: hostInit.mcp_servers.map((s) => (s.name === 'postbox' ? { ...s, status: 'connected' } : s)) };
  assert.ok(
    init.mcp_servers.some((s) => s.name !== 'postbox' && s.status === 'failed'),
    'the recorded init has others failed',
  );
  const ctx = fakeCtx();
  createStreamMapper(ctx, { now: () => 1000 }).push(init);
  assert.ok(!ctx.calls.activity.some((a) => a.label === 'Postbox’s tools didn’t load'));
  assert.equal(ctx.calls.saved.postboxToolsDown, undefined, 'and nothing is saved for the next turn');
});

test('#1161 a re-attach after a restart leaves the note for the next real turn, which is told first', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  d.addTurn('tr-again', { harness: 'claude-code', lines: fixtureLines('block'), exit: { code: 0, signal: null } });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-tools-down-host-'), ...forbidden() });
  const state = { claudeSessionId: '11111111-1111-4111-8111-111111111111', postboxToolsDown: 'ran' };
  const attach = remoteCtx(d, { state, remote: { attach: { turn: 'tr-again' } } });
  await adapter.deliver({}, { kind: 'user', text: 'not sent again' }, attach);
  assert.equal(starts(d).length, 0, 'an attach starts nothing');
  assert.equal(attach.calls.saved.postboxToolsDown, undefined, 'the attach doesn’t take the note');
  const next = remoteCtx(d, { state: { ...state } });
  await adapter.deliver({}, { kind: 'user', text: 'Try again.' }, next);
  const message = starts(d)[0].files.find((f) => f.name === MESSAGE_FILE).text;
  assert.match(message, told, 'the next real turn is told first');
  assert.equal(next.calls.saved.postboxToolsDown, null, 'and the note is taken there');
});

// A command is the whole prompt (#67), and a re-attach sends the agent nothing (#120): neither can carry the note.
for (const [what, message] of [
  ['a slash command', { kind: 'user', text: '/compact', slash: true }],
  ['a re-attached turn', { kind: 'user', text: '', attach: 'host-turn-1' }],
]) {
  test(`#1161 Claude Code: ${what} isn’t prefixed, and the note waits for the next turn`, async () => {
    const { spawnImpl, runs } = fakeSpawn(() => fineTurn());
    const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-tools-down-work-'), spawnImpl });
    const ctx = fakeCtx({ state: { postboxToolsDown: true } });
    await adapter.deliver({}, message, ctx);
    assert.doesNotMatch(promptOf(runs[0]), /\[Postbox\] In your last turn/, 'the prompt is the command alone');
    assert.equal(ctx.state.postboxToolsDown, true, 'the note is still owed');
    await adapter.deliver({}, { kind: 'user', text: 'Try again.' }, ctx);
    assert.match(promptOf(runs[1]), told, 'the next turn is told first');
  });

  test(`#1161 the Agent SDK: ${what} isn’t prefixed, and the note waits for the next turn`, async () => {
    const sdk = fakeSdk(() => fineTurn());
    const adapter = new AgentSdkAdapter({ sdk, workRoot: tempDir('pb-tools-down-sdk-') });
    const ctx = fakeCtx({ state: { postboxToolsDown: true } });
    await adapter.deliver({}, message, ctx);
    assert.doesNotMatch(String(sdk.calls[0].prompt), /\[Postbox\] In your last turn/, 'the prompt is the command alone');
    assert.equal(ctx.state.postboxToolsDown, true, 'the note is still owed');
    await adapter.deliver({}, { kind: 'user', text: 'Try again.' }, ctx);
    assert.match(String(sdk.calls[1].prompt), told, 'the next turn is told first');
  });
}
