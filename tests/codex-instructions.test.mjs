// Codex’s thread protocol accepts developerInstructions on start, resume and fork.
// A turn/start settings object does not deliver Postbox’s persona or writing guide.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { fakeAppServer } from './codex-fixture.mjs';

function context(state) {
  return {
    persona: { handle: 'coder', backend: 'codex', instructions: 'Keep handoffs readable.', permissionMode: 'auto' },
    project: { folder: '/tmp/postbox-codex-instructions' },
    handles: ['coder', 'reviewer'],
    state,
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=instructions',
    text() {},
    activity() {},
    status() {},
    checkpoint() {},
    pathOf: () => null,
    saveState: (patch) => Object.assign(state, patch),
  };
}

for (const [name, state, method] of [
  ['a new thread', {}, 'thread/start'],
  ['a resumed thread', { codexThreadId: 'thr_existing' }, 'thread/resume'],
  ['a forked thread', { fork: { threadId: 'thr_parent', turnId: 'turn_parent' } }, 'thread/fork'],
]) {
  test(`Postbox’s persona and Markdown handoff instructions reach ${name} through the supported field`, async () => {
    const seen = [];
    const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen) });
    await adapter.deliver({}, { kind: 'user', text: 'Hand off the fix.' }, context(structuredClone(state)));
    const opened = seen.find((request) => request.method === method);
    const guide = opened.params.developerInstructions;
    assert.equal(typeof guide, 'string', 'developerInstructions belongs on the thread request');
    assert.match(guide, /Keep handoffs readable\./);
    assert.match(guide, /## How you write here/);
    assert.match(guide, /commentary|progress updates/);
    assert.match(guide, /\*\*Handoff: ready for review\*\*\n\n- \*\*Change:\*\*/);
    const turn = seen.find((request) => request.method === 'turn/start');
    assert.equal('settings' in turn.params, false, 'unsupported turn settings cannot carry the guide');
    assert.ok(turn.params.input[0].text.startsWith('Hand off the fix.'));
  });
}

test('resuming an existing thread uses the persona version supplied by the runtime', async () => {
  const seen = [];
  const state = {};
  const ctx = context(state);
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen) });
  await adapter.deliver({}, { kind: 'user', text: 'First turn.' }, ctx);
  ctx.persona.instructions = 'Use concise Markdown in every handoff.';
  await adapter.deliver({}, { kind: 'user', text: 'Continue.' }, ctx);
  const resumed = seen.find((request) => request.method === 'thread/resume');
  assert.equal(resumed.params.threadId, 'thr_fake');
  assert.match(resumed.params.developerInstructions, /Use concise Markdown in every handoff\./);
  assert.doesNotMatch(resumed.params.developerInstructions, /Keep handoffs readable\./);
});
