// #587: recordings from #586, Case A. The recorded start returned an id but the next process could not resume it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { fakeAppServer } from './codex-fixture.mjs';

const recorded = (name) =>
  readFileSync(new URL(`fixtures/codex-app-server/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
const lostId = recorded('fail-before-output').find((m) => m.result?.thread).result.thread.id;
const missing = recorded('resume-after-failure').find((m) => m.error).error;
const message = { kind: 'user', text: 'Continue the work.' };

function context(state = { codexThreadId: lostId }) {
  const saved = [];
  const abort = new AbortController();
  return {
    saved,
    abort,
    state,
    signal: abort.signal,
    persona: { handle: 'coder', backend: 'codex', instructions: 'Pinned persona.', permissionMode: 'auto' },
    project: { folder: '/tmp/postbox-codex-missing' },
    handles: ['coder'],
    mcpUrl: 'http://127.0.0.1:1/mcp',
    text() {},
    activity() {},
    status() {},
    checkpoint() {},
    pathOf: () => null,
    saveState(patch) {
      saved.push(patch);
      Object.assign(state, patch);
    },
  };
}

test('a recorded missing rollout clears the saved id and starts fresh once, telling the agent what was lost', async () => {
  const seen = [];
  const ctx = context();
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen, { threadError: (r) => (r.method === 'thread/resume' ? missing : null) }) });
  await adapter.deliver({}, message, ctx);
  assert.deepEqual(
    seen.filter((r) => r.method?.startsWith('thread/')).map((r) => r.method),
    ['thread/resume', 'thread/start'],
  );
  assert.equal(ctx.saved[0].codexThreadId, null);
  assert.equal(ctx.state.codexThreadId, 'thr_fake');
  const opened = seen.find((r) => r.method === 'thread/start');
  assert.match(opened.params.developerInstructions, /Pinned persona\./);
  const turn = seen.find((r) => r.method === 'turn/start');
  assert.equal(turn.params.threadId, 'thr_fake');
  assert.match(turn.params.input[0].text, /earlier conversation in this thread couldn’t be loaded, so this is a fresh start/);
  assert.match(turn.params.input[0].text, /Continue the work\./);
  assert.equal(message.text, 'Continue the work.', 'the caller’s message is unchanged');
});

test('an unrelated resume error does not erase the saved thread or start another one', async () => {
  const seen = [];
  const ctx = context();
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen, { threadError: () => ({ code: -32600, message: 'invalid configuration' }) }) });
  await assert.rejects(adapter.deliver({}, message, ctx), /invalid configuration/);
  assert.equal(ctx.state.codexThreadId, lostId);
  assert.deepEqual(ctx.saved, []);
  assert.equal(
    seen.some((r) => r.method === 'thread/start'),
    false,
  );
});

test('a missing fork checkpoint is surfaced without silently replacing the requested branch', async () => {
  const seen = [];
  const ctx = context({ fork: { threadId: lostId, turnId: 'turn_source' } });
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen, { threadError: () => missing }) });
  await assert.rejects(adapter.deliver({}, message, ctx), /no rollout found/);
  assert.deepEqual(ctx.saved, []);
  assert.equal(
    seen.some((r) => r.method === 'thread/start'),
    false,
  );
});

test('if the replacement thread fails to start, the stale id stays cleared and recovery does not loop', async () => {
  const seen = [];
  const ctx = context();
  const adapter = new CodexAdapter({
    spawnImpl: () => fakeAppServer(seen, { threadError: (r) => (r.method === 'thread/resume' ? missing : { code: -32603, message: 'replacement refused' }) }),
  });
  await assert.rejects(adapter.deliver({}, message, ctx), /replacement refused/);
  assert.equal(ctx.state.codexThreadId, null);
  assert.equal(seen.filter((r) => r.method === 'thread/start').length, 1);
  assert.equal(
    seen.some((r) => r.method === 'turn/start'),
    false,
  );
});

test('stopping while a missing resume is answered never starts a replacement turn', async () => {
  const seen = [];
  const ctx = context();
  const adapter = new CodexAdapter({
    spawnImpl: () =>
      fakeAppServer(seen, {
        threadError: () => {
          ctx.abort.abort();
          return missing;
        },
      }),
  });
  await assert.rejects(adapter.deliver({}, message, ctx), /no rollout found|abort|stop/i);
  assert.equal(
    seen.some((r) => r.method === 'thread/start'),
    false,
  );
});
