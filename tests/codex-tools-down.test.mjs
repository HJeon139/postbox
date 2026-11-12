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

test('#1162 the failed step gives Codex’s own words as text, bounded', async () => {
  const ctx = context();
  const { message } = refused('postbox');
  const long = { code: -32603, message: `${message} <b>bold</b> ${'x'.repeat(2000)} the very end` };
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer([], { threadError: () => long }) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi.' }, ctx), (e) => !e.message.includes('handshaking'));
  const { detail } = down(ctx);
  assert.ok(detail.includes('required MCP servers failed to initialize: postbox: handshaking with MCP server failed'), 'Codex’s reason');
  assert.ok(detail.includes('<b>bold</b>'), 'as it was sent, with nothing turned into markup');
  assert.ok(!detail.includes('the very end'), 'cut short');
  assert.ok(detail.length < 600, `bounded, at ${detail.length} characters`);
});

test('#1162 another required server failing keeps Codex’s own words, with no Postbox step', async () => {
  const ctx = context();
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer([], { threadError: () => refused('notebook') }) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi.' }, ctx), /required MCP servers failed to initialize: notebook/);
  assert.equal(down(ctx), undefined);
});

test('#1162 “postbox:” inside another server’s error detail isn’t Postbox’s server failing', async () => {
  const ctx = context();
  const message =
    'error creating thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: docs: handshaking with MCP server failed: tried the postbox: socket';
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer([], { threadError: () => ({ code: -32603, message }) }) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi.' }, ctx), /tried the postbox: socket/);
  assert.equal(down(ctx), undefined);
});
