import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGY_CAPABILITIES } from '../server/adapters/antigravity-cli.mjs';
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

/** A boilerplate the person saved from a persona (seed.mjs, toBoilerplate). */
const saved = (backend, model) => ({ id: 'bp_saved1', name: '@mine', description: '', instructions: '', tools: [], backend, model });
const sheet = () => ({ backend: 'claude-code', model: 'claude-opus-5-5', effort: 'medium', tools: new Set() });

test('#1305 a boilerplate the person saved starts on its own model, though its backend doesn’t list it', () => {
  const st = sheet();
  const config = { adapters: ['claude-code', 'codex'], backends: { codex: { models: ['gpt-6.1-sol', 'auto'] } } };
  applyBoilerplate(st, saved('codex', 'my-gateway/gpt-custom'), config);
  assert.deepEqual([st.backend, st.model], ['codex', 'my-gateway/gpt-custom']);
});

test('#1305 Postbox’s own Gemini boilerplate still falls back to a Gemini model agy lists', () => {
  const st = sheet();
  // agy’s capabilities, as the page’s config carries them: its preferred model decides the fallback (#390).
  const config = {
    adapters: ['claude-code', 'antigravity-cli'],
    backends: { 'antigravity-cli': { ...AGY_CAPABILITIES, models: ['claude-sonnet-4-6', 'gemini-4-argon-medium'] } },
  };
  applyBoilerplate(
    st,
    BOILERPLATES.find((b) => b.id === 'bp-gemini'),
    config,
  );
  assert.deepEqual([st.backend, st.model], ['antigravity-cli', 'gemini-4-argon-medium']);
});

test('#1305 every boilerplate Postbox ships says it’s Postbox’s own, and one saved from a persona doesn’t', async () => {
  const { toBoilerplate } = await import('../server/seed.mjs');
  for (const b of BOILERPLATES) assert.equal(b.builtIn, true, b.id);
  assert.equal(toBoilerplate({ handle: 'mine', description: '', instructions: '', tools: [], backend: 'codex', model: 'gpt-6' }).builtIn, undefined);
});
