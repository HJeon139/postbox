import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOILERPLATES } from '../server/seed.mjs';
import { applyBoilerplate } from '../shared/agent-facts.mjs';

test('choosing GPT replaces a Claude model with the model offered by Codex', () => {
  const draft = { backend: 'claude-code', model: 'claude-example', handle: 'helper', permissionMode: 'ask' };
  applyBoilerplate(
    draft,
    BOILERPLATES.find((b) => b.id === 'bp-gpt'),
    { adapters: ['codex'], backends: { codex: { models: ['gpt-example'] } } },
  );
  assert.equal(draft.backend, 'codex');
  assert.equal(draft.model, 'gpt-example');
  assert.equal(draft.handle, 'helper');
  assert.equal(draft.permissionMode, 'ask');
  applyBoilerplate(
    draft,
    BOILERPLATES.find((b) => b.id === 'bp-critic'),
  );
  assert.equal(draft.backend, 'mock');
});

test('GPT leaves the model empty for the backend default when Codex lists no models', () => {
  const draft = { model: 'claude-example' };
  applyBoilerplate(
    draft,
    BOILERPLATES.find((b) => b.id === 'bp-gpt'),
    { adapters: ['codex'] },
  );
  assert.equal(draft.model, '');
});
