// #1161: Claude Code’s init lists each MCP server with a status. When Postbox’s own server failed, as in the init
// recorded on a host (fixtures/claude-code/host-mcp-init.jsonl), the turn ran with no Postbox tools and no one was
// told. The person now sees a failed step, and the agent hears of it at its next turn, once. The status is read from
// the init alone, so a local run and a host run are alike; the Agent SDK uses the same mapper.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
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
