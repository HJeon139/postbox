// A backend-selected Codex model is named honestly without suppressing explicit model mismatches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentGuide } from '../server/adapters/guide.mjs';
import { DEFAULT_MODEL } from '../server/adapters/setup.mjs';
import { chipModel, factsText, runsWith } from '../shared/agent-facts.mjs';

const config = { defaultModel: DEFAULT_MODEL };

test('Codex’s unoffered runtime fallback is labeled as its default before the first answer', () => {
  const persona = { backend: 'codex', model: DEFAULT_MODEL };
  const facts = runsWith({}, persona, config);
  assert.equal(facts.setModelName, 'Codex’s default');
  assert.equal(chipModel(facts), 'Codex’s default');
  assert.ok(!factsText(facts).includes(DEFAULT_MODEL));
  const guide = agentGuide({ persona, handles: [] });
  assert.match(guide, /Postbox has you set to Codex · Codex’s default/);
  assert.ok(!guide.includes(DEFAULT_MODEL));
});

test('an actual Codex model is not a mismatch with its backend default', () => {
  for (const model of [DEFAULT_MODEL, '']) {
    const facts = runsWith({ lastModel: 'gpt-example' }, { backend: 'codex', model }, config);
    assert.equal(facts.modelDiffers, false);
    assert.equal(chipModel(facts), 'gpt-example');
  }
});

test('explicit Codex models and Claude’s empty-model fallback still detect mismatches', () => {
  assert.equal(runsWith({ lastModel: 'gpt-other' }, { backend: 'codex', model: 'gpt-example' }, config).modelDiffers, true);
  assert.equal(runsWith({ lastModel: 'claude-sonnet-5-5' }, { backend: 'claude-code', model: '' }, config).modelDiffers, true);
});

test('a Claude model explicitly offered by Codex remains its named setting in status and the guide', () => {
  const persona = { backend: 'codex', model: DEFAULT_MODEL };
  const models = [DEFAULT_MODEL];
  const facts = runsWith({}, persona, { ...config, backends: { codex: { models } } });
  assert.equal(facts.setModel, DEFAULT_MODEL);
  assert.match(agentGuide({ persona, handles: [], models }), /claude-opus-5-5/);
});

test('an unoffered Sonnet model inherited by Codex uses the same default status as its requests', () => {
  const persona = { backend: 'codex', model: 'claude-sonnet-5-5' };
  assert.equal(chipModel(runsWith({}, persona, config)), 'Codex’s default');
  assert.ok(!agentGuide({ persona, handles: [] }).includes(persona.model));
  assert.equal(runsWith({ lastModel: 'gpt-example' }, persona, config).modelDiffers, false);
  const offered = { ...config, backends: { codex: { models: [persona.model] } } };
  assert.equal(runsWith({ lastModel: 'gpt-example' }, persona, offered).modelDiffers, true);
});
