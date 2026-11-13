// The model a sheet picks for a backend, from the models its harness listed (server/model-lists.mjs), and a model
// the person typed, which no list replaces.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../server/adapters/setup.mjs';
import * as facts from '../shared/agent-facts.mjs';

const listed = (backend, models) => ({
  defaultModel: DEFAULT_MODEL,
  defaultEffort: DEFAULT_EFFORT,
  adapters: ['claude-code', 'codex', 'kiro-cli', 'mock'],
  backends: { [backend]: { models } },
});

test('Postbox keeps no list of Claude’s models of its own', () => {
  assert.equal(Object.hasOwn(facts, 'MODELS'), false);
});

test('a backend whose harness lists Postbox’s default starts on it', () => {
  assert.equal(facts.modelDefault('claude-code', listed('claude-code', ['claude-fable-5-2', DEFAULT_MODEL])), DEFAULT_MODEL);
});

test('a backend whose harness no longer lists Postbox’s default starts on the first model it lists', () => {
  assert.equal(facts.modelDefault('claude-code', listed('claude-code', ['claude-opus-6', 'claude-sonnet-6'])), 'claude-opus-6');
});

test('a backend that hasn’t listed its models yet starts on Postbox’s default', () => {
  assert.equal(facts.modelDefault('claude-code', listed('codex', ['gpt-5.6'])), DEFAULT_MODEL);
});

test('a model of no list stays when switching to a backend that hasn’t listed its models yet', () => {
  const st = { backend: 'claude-code', model: 'my-gateway/claude-custom', effort: 'high' };
  facts.selectBackend(st, 'kiro-cli', listed('codex', ['gpt-5.6', 'auto']));
  assert.deepEqual([st.backend, st.model, st.effort], ['kiro-cli', 'my-gateway/claude-custom', 'high']);
});

test('a model Postbox picked moves to the new backend’s default when that backend doesn’t list it', () => {
  const st = { backend: 'claude-code', model: DEFAULT_MODEL, effort: 'high', modelDefaulted: true };
  facts.selectBackend(st, 'codex', listed('codex', ['gpt-5.6', 'auto']));
  assert.deepEqual([st.model, st.modelDefaulted], ['gpt-5.6', true]);
});

test('a model from the previous backend’s list doesn’t carry over to one that hasn’t listed yet', () => {
  const config = { ...listed('codex', ['gpt-5.6', 'auto']) };
  const st = { backend: 'codex', model: 'gpt-5.6', effort: 'medium' };
  facts.selectBackend(st, 'kiro-cli', config);
  assert.equal(st.model, DEFAULT_MODEL);
});

test('a boilerplate’s model isn’t Postbox’s pick, so a list arriving afterwards leaves it', () => {
  const st = { backend: 'claude-code', model: DEFAULT_MODEL, effort: 'medium', modelDefaulted: true, tools: new Set() };
  const gpt = { id: 'bp-gpt', backend: 'codex', model: 'gpt-5.6', tools: [] };
  facts.applyBoilerplate(st, gpt, listed('codex', ['gpt-6', 'gpt-5.6']));
  assert.deepEqual([st.model, st.modelDefaulted], ['gpt-5.6', false]);
});
