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
  assert.match(inputOf(seen[1]), /the turn didn’t run and you never got its message/, 'worded for a turn that never ran');
  assert.match(inputOf(seen[1]), /read_conversation has it/, 'and says where the message is');
  assert.match(inputOf(seen[1]), /Try again\./, 'then its request');
  await adapter.deliver({}, { kind: 'user', text: 'Once more.' }, ctx);
  assert.doesNotMatch(inputOf(seen[2]), told, 'and only once');
});

// formatMessage reads message.text only for some kinds, so the note goes in front of what it returns.
for (const [kind, message] of [
  ['a person’s message', { kind: 'user', text: 'Try again.' }],
  ['an agent’s message', { kind: 'agent', from: 'reviewer', text: 'Try again.' }],
  ['a wake-up', { kind: 'wake', note: 'Try again.' }],
  ['a block event', { kind: 'event', event: { blockId: 'b1', action: 'submit', values: {} } }],
  ['a lint turn', { kind: 'lint', text: 'Try again.', problems: [] }],
  ['an app’s failed check', { kind: 'app-check', appId: 'a1', problems: [] }],
  ['a notice', { kind: 'notice', text: 'Try again.' }],
  ['a queue of messages', { kind: 'user', messages: [{ kind: 'user', text: 'Try again.' }] }],
]) {
  test(`#1162 ${kind} is told first that Postbox’s tools didn’t load`, async () => {
    const ctx = context();
    Object.assign(ctx.state, { postboxToolsDown: 'refused' });
    const seen = [];
    const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen) });
    await adapter.deliver({}, message, ctx);
    assert.match(inputOf(seen), told);
    assert.equal(ctx.state.postboxToolsDown, null, 'and it’s told once');
  });
}

// A command is the whole prompt (#67), and a re-attach sends the agent nothing (#120).
for (const [what, message] of [
  ['a slash command', { kind: 'user', text: '/review', slash: true }],
  ['a re-attached turn', { kind: 'user', text: '', attach: 'host-turn-1' }],
]) {
  test(`#1162 ${what} isn’t prefixed, and the note waits for the next turn`, async () => {
    const ctx = context();
    Object.assign(ctx.state, { postboxToolsDown: 'ran' });
    const seen = [];
    const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen) });
    await adapter.deliver({}, message, ctx);
    assert.doesNotMatch(inputOf(seen), /\[Postbox\] In your last turn/);
    assert.equal(ctx.state.postboxToolsDown, 'ran', 'the note is still owed');
  });
}
