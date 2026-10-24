// The model a Codex turn names (#120): only one Codex runs, so a Claude model, auto or the mock names none. Apart from
// tests/codex.test.mjs, which is at its length ceiling.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter, codexModelOf } from '../server/adapters/codex.mjs';
import { fakeAppServer } from './codex-fixture.mjs';

test('Codex is sent only a model it runs: auto, the mock and Claude’s models name none, so Codex uses its own default (#120)', () => {
  assert.equal(codexModelOf({ model: 'gpt-5.6-terra' }), 'gpt-5.6-terra');
  for (const model of ['auto', 'mock', 'claude-opus-5-5', 'claude-haiku-5-5', '', undefined]) assert.equal(codexModelOf({ model }), null, String(model));
  // The model field offers auto after what the CLI lists, and alone with no list (Codex only on a host), never
  // falling back to Claude’s models.
  assert.deepEqual(new CodexAdapter({ workRoot: '/nowhere', models: ['gpt-5.6-terra'] }).capabilities.models, ['gpt-5.6-terra', 'auto']);
  assert.deepEqual(new CodexAdapter({ workRoot: '/nowhere' }).capabilities.models, ['auto']);
});

test('a Codex persona with Claude’s default model (made before Postbox had Codex’s list) starts its thread and turn naming no model', async () => {
  const seen = [];
  const adapter = new CodexAdapter({ workRoot: '/tmp/postbox-codex-test', spawnImpl: () => fakeAppServer(seen) });
  const reported = [];
  const ctx = {
    persona: { handle: 'critic', model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'acceptEdits' },
    project: { folder: '/tmp/postbox-codex-test/project' },
    handles: ['critic'],
    state: {},
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    reported: (r) => reported.push(r),
    pathOf: () => null,
  };
  await adapter.deliver({}, { kind: 'user', text: 'Say hello.' }, ctx);
  assert.ok(!('model' in seen.find((x) => x.method === 'thread/start').params));
  assert.ok(!('model' in seen.find((x) => x.method === 'turn/start').params));
  assert.deepEqual(reported, [{ effort: 'medium' }], 'no model to report when Codex names none');
});
