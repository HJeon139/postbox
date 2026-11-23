// Codex’s thread protocol accepts developerInstructions on start, resume and fork.
// A turn/start settings object does not deliver Postbox’s persona or writing guide.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { fakeAppServer } from './codex-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

// Fixed paths under /tmp outlive the run and collide between users (#823); each is a temp folder of this file’s.
const CODEX_DIR = tempDir('postbox-codex-instructions-');

function context(state) {
  return {
    persona: { handle: 'coder', backend: 'codex', instructions: 'Keep handoffs readable.', permissionMode: 'auto' },
    project: { folder: CODEX_DIR },
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

// A resume that returns the thread's whole history can outgrow a host's 8 MiB line, and then never answers (#1705).
// Recorded with codex-cli 0.171.0.978: with excludeTurns the answer keeps its thread id and model, lists no turns, and
// Codex sends no deprecationNotice for full-history hydration.
test('resuming a thread asks Codex for no past turns, as a fork does', async () => {
  const seen = [];
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen) });
  await adapter.deliver({}, { kind: 'user', text: 'Continue.' }, context({ codexThreadId: 'thr_existing' }));
  const resumed = seen.find((request) => request.method === 'thread/resume');
  assert.equal(resumed.params.threadId, 'thr_existing');
  assert.equal(resumed.params.excludeTurns, true, 'the resume answer must not carry the thread’s history');
});

// Before the fix the turn waited for that answer for good; the timeout makes that a failure, not a hung run.
test('a resume answer the host had to leave out fails the turn, and stops the app-server holding the thread (#1705)', { timeout: 5000 }, async () => {
  const seen = [];
  let killed = false;
  const adapter = new CodexAdapter({
    spawnImpl: () => {
      const child = fakeAppServer(seen, { cut: (r) => r.method === 'thread/resume' });
      const kill = child.kill;
      child.kill = (sig) => {
        killed = true;
        return kill(sig);
      };
      return child;
    },
  });
  const turn = adapter.deliver({}, { kind: 'user', text: 'Continue.' }, context({ codexThreadId: 'thr_existing' }));
  await assert.rejects(turn, /thread\/resume.*too long to send from the host/);
  assert.equal(
    seen.some((r) => r.method === 'turn/start'),
    false,
    'no turn starts on a thread it never opened',
  );
  assert.ok(killed, 'the app-server is stopped, so it no longer holds the thread');
});
