// #1162: Postbox marks its MCP server required for Codex, so when the server can’t start, Codex refuses the thread.
// Checked with codex-cli 0.167.0 on 10 Nov, with Postbox’s server pointed at a closed port: no startupStatus came for
// it, and thread/start answered with JSON-RPC error -32603, “error creating thread: Fatal error: Failed to initialize
// session: required MCP servers failed to initialize: postbox: handshaking with MCP server failed: …”. The turn failed
// with that text, several hundred characters of transport detail, and nothing said it was Postbox’s tools. Now the
// person sees a failed step and a reply that says so, and the agent hears of it at its next turn, once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { fakeAppServer } from './codex-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

/** The thread/start error Codex 0.167.0 sent, cut where its transport detail began. @param {string} server */
const refused = (server) => ({
  code: -32603,
  message: `error creating thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: ${server}: handshaking with MCP server failed: Send message error Transport [codex_rmcp_client::tool_list_changes::ToolListChanges<…>] error: Client error: http/request failed`,
});

function context() {
  const calls = { activity: [] };
  const state = {};
  return {
    calls,
    persona: { handle: 'coder', backend: 'codex', permissionMode: 'auto' },
    project: { folder: tempDir('pb-codex-down-') },
    handles: ['coder'],
    state,
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=down',
    text() {},
    activity: (a) => calls.activity.push(a),
    status() {},
    checkpoint() {},
    pathOf: () => null,
    saveState: (patch) => Object.assign(state, patch),
  };
}

const down = (ctx) => ctx.calls.activity.find((a) => a.label === 'Postbox’s tools didn’t load');
const inputOf = (seen) => seen.find((r) => r.method === 'turn/start')?.params.input[0].text ?? '';
const told = /^\[Postbox\] In your last turn, Postbox’s tool server didn’t start/;

test('#1162 Codex refusing the thread for Postbox’s server is a failed step, and the reply says so in plain words', async () => {
  const ctx = context();
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer([], { threadError: () => refused('postbox') }) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Show a block.' }, ctx), (e) => {
    assert.match(e.message, /^Postbox’s tools didn’t load/);
    assert.doesNotMatch(e.message, /rmcp|Transport \[/, 'not Codex’s transport detail');
    return true;
  });
  const step = down(ctx);
  assert.ok(step, 'a step says so');
  assert.equal(step.state, 'failed');
});

test('#1162 another required server failing keeps Codex’s own words, with no Postbox step', async () => {
  const ctx = context();
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer([], { threadError: () => refused('notebook') }) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi.' }, ctx), /required MCP servers failed to initialize: notebook/);
  assert.equal(down(ctx), undefined);
});

test('#1162 the next Codex turn is told first that Postbox’s tools didn’t load, and only once', async () => {
  const ctx = context();
  let n = 0;
  const seen = [[], [], []];
  const adapter = new CodexAdapter({
    spawnImpl: () => {
      const i = n++;
      return fakeAppServer(seen[i], { threadError: () => (i === 0 ? refused('postbox') : null) });
    },
  });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Show a block.' }, ctx));
  await adapter.deliver({}, { kind: 'user', text: 'Try again.' }, ctx);
  assert.match(inputOf(seen[1]), told, 'the next turn is told first');
  assert.match(inputOf(seen[1]), /Try again\./, 'then its request');
  await adapter.deliver({}, { kind: 'user', text: 'Once more.' }, ctx);
  assert.doesNotMatch(inputOf(seen[2]), told, 'and only once');
});
