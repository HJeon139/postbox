// What an agent runs with, in words (#60): the model that answered its last turn, marked when it differs from
// the setting, and the effort. The top bar, the overview card and the menus read these.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGY_DEFAULT_MODEL } from '../server/adapters/antigravity-cli.mjs';
import { DEFAULT_EFFORT, DEFAULT_MODEL, effortOf, modelOf } from '../server/adapters/setup.mjs';
import { BOILERPLATES } from '../server/seed.mjs';
import {
  applyBoilerplate,
  boilerplateUnavailable,
  chipEffort,
  chipModel,
  factsText,
  GEMINI_MODEL,
  installNote,
  modelName,
  runsWith,
  sameModel,
  selectBackend,
  shortModel,
} from '../shared/agent-facts.mjs';

const config = { defaultModel: DEFAULT_MODEL, defaultEffort: DEFAULT_EFFORT };

test('a short model name only where the id is unambiguous', () => {
  assert.equal(shortModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(shortModel('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(shortModel('claude-fable-5-1'), 'Fable 5.1');
  // Anything else is shown as it is.
  assert.equal(shortModel('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5-20250929');
  assert.equal(shortModel('opus'), 'opus');
});

test('a setting with a context suffix or a family alias isn’t marked as a different model', () => {
  assert.equal(sameModel('claude-opus-5-5', 'claude-opus-5-5[1m]'), true);
  assert.equal(sameModel('claude-opus-5-5', 'opus'), true);
  assert.equal(sameModel('claude-opus-5-5', 'opus[1m]'), true);
  assert.equal(sameModel('claude-sonnet-5-5', 'opus'), false);
  assert.equal(sameModel('claude-sonnet-5-5', 'claude-opus-5-5'), false);
  const persona = { backend: 'claude-code', model: 'claude-opus-5-5[1m]', effort: 'medium' };
  const f = runsWith({ personaSnapshot: { ...persona }, lastModel: 'claude-opus-5-5' }, persona, config);
  assert.equal(f.modelDiffers, false);
  assert.equal(chipModel(f), 'Opus 5.5');
});

test('before its first turn, an agent shows the model and effort it’s set to', () => {
  const persona = { backend: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' };
  const se = { personaSnapshot: { model: 'claude-sonnet-5-5', effort: 'high' } };
  const f = runsWith(se, persona, config);
  assert.deepEqual([f.model, f.answered, f.modelDiffers, f.effort, f.effortDiffers], ['claude-sonnet-5-5', false, false, 'high', false]);
  assert.equal(chipModel(f), 'Sonnet 5.5');
  assert.equal(chipEffort(f), 'high effort');
  assert.equal(factsText(f), 'Claude Code · claude-sonnet-5-5 · high effort');
});

test('the model that answered the last turn, marked in words when it isn’t the one set', () => {
  const persona = { backend: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' };
  const se = { personaSnapshot: { model: 'claude-opus-5-5', effort: 'medium' }, lastModel: 'claude-sonnet-5-5', lastEffort: 'medium' };
  const f = runsWith(se, persona, config);
  assert.equal(f.modelDiffers, true);
  assert.equal(chipModel(f), 'Sonnet 5.5, not Opus 5.5');
  assert.equal(factsText(f), 'Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · medium effort');
  // The same model is not marked.
  const same = runsWith({ ...se, lastModel: 'claude-opus-5-5' }, persona, config);
  assert.equal(chipModel(same), 'Opus 5.5');
  assert.equal(factsText(same), 'Claude Code · claude-opus-5-5 · medium effort');
});

test('an effort changed since the last turn says both', () => {
  const se = { backend: 'agent-sdk', personaSnapshot: { model: 'claude-opus-5-5', effort: 'xhigh' }, lastEffort: 'low' };
  const f = runsWith(se, { backend: 'agent-sdk' }, config);
  assert.equal(chipEffort(f), 'low effort, set to extra high');
  assert.equal(factsText(f), 'Agent SDK · claude-opus-5-5 · low effort on the last turn, set to extra high');
});

test('the setting is what the server runs with: the snapshot, then the persona, then the defaults', () => {
  // A session from before effort existed, of a persona moved from the mock to a real backend.
  const persona = { backend: 'claude-code', model: DEFAULT_MODEL };
  const se = { backend: 'mock', personaSnapshot: { model: 'mock' } };
  const f = runsWith(se, persona, config);
  const runs = { ...persona, ...se.personaSnapshot };
  assert.equal(f.mock, false);
  assert.ok(!f.mock && f.setModel === modelOf(runs) && f.setEffort === effortOf(runs));
});

test('a mock agent says it runs scripted replies, with no model or effort', () => {
  const f = runsWith({ backend: 'mock', personaSnapshot: { model: 'mock' } }, { backend: 'mock', model: 'mock' }, config);
  assert.equal(f.mock, true);
  assert.equal(chipModel(f), '');
  assert.equal(chipEffort(f), '');
  assert.equal(factsText(f), 'Mock agent · scripted replies, not a model');
  // The persona’s backend decides, since a change to it reaches the session from its next turn.
  assert.equal(runsWith({ backend: 'mock' }, { backend: 'claude-code', model: 'claude-opus-5-5' }, config).mock, false);
  assert.equal(runsWith({ backend: 'claude-code' }, { backend: 'mock' }, config).mock, true);
  // A deleted persona falls back to the session’s.
  assert.equal(runsWith({ backend: 'mock' }, undefined, config).mock, true);
});

test('the overview says how to install Claude Code only when Postbox looked for it and didn’t find it', () => {
  const missing = { realBackends: true, versions: { claudeCode: null } };
  // Nothing real to run on: the agents run on the mock.
  assert.match(installNote({ ...missing, adapters: ['mock'] }) ?? '', /run on the mock until it is: scripted replies, not a model/);
  // The Agent SDK loaded without it.
  assert.match(installNote({ ...missing, adapters: ['mock', 'agent-sdk'] }) ?? '', /run on the Agent SDK or the mock until it is/);
  // Installed, or not looked for (--demo, POSTBOX_BACKENDS=mock): no line.
  assert.equal(installNote({ realBackends: true, versions: { claudeCode: '2.1.296' }, adapters: ['mock', 'claude-code'] }), null);
  assert.equal(installNote({ realBackends: false, versions: { claudeCode: null }, adapters: ['mock'] }), null);
  assert.equal(installNote({}), null);
});

test('#208: a Claude Code too old to keep a memory per agent says so in the overview', () => {
  const at = (claudeCode) => installNote({ realBackends: true, versions: { claudeCode }, adapters: ['mock', 'claude-code'] });
  // autoMemoryDirectory came in 2.1.74 (Claude Code’s CHANGELOG): before it, agents in a project share one memory.
  assert.match(at('2.1.73 (Claude Code)') ?? '', /Claude Code 2\.1\.73 keeps one memory for every agent in a project\. Update it to 2\.1\.74 or later/);
  assert.equal(at('2.1.74 (Claude Code)'), null);
  assert.equal(at('2.1.310'), null);
});

test('#120 L6: a Codex agent set to auto, or to a Claude model it ignores, reads as Codex’s default, never a Claude model', () => {
  const config = { defaultModel: DEFAULT_MODEL, defaultEffort: DEFAULT_EFFORT };
  for (const model of ['auto', 'claude-opus-5-5']) {
    const f = runsWith({ personaSnapshot: { model, effort: 'medium' } }, { backend: 'codex' }, config);
    assert.equal(chipModel(f), 'Codex’s default');
    assert.equal(factsText(f), 'Codex · Codex’s default · medium effort');
  }
  // The model that answered is whichever Codex picked, so it isn’t marked as different from the default.
  const answered = runsWith({ personaSnapshot: { model: 'auto', effort: 'medium' }, lastModel: 'gpt-5.5' }, { backend: 'codex' }, config);
  assert.equal(answered.modelDiffers, false);
  assert.equal(chipModel(answered), 'gpt-5.5');
  // A model Codex names is shown as it is, and on Claude Code a Claude model keeps its short name.
  assert.equal(modelName('codex', 'gpt-5.5'), 'gpt-5.5');
  assert.equal(modelName('claude-code', 'claude-opus-5-5'), 'Opus 5.5');
});

test('picking the Gemini boilerplate prefers its model when offered, then the first gemini-* model, then its model', () => {
  assert.equal(GEMINI_MODEL, AGY_DEFAULT_MODEL);
  const gemini = BOILERPLATES.find((b) => b.id === 'bp-gemini');
  const critic = BOILERPLATES.find((b) => b.id === 'bp-critic');
  const st = { bp: 'bp-critic', backend: 'claude-code', model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, instructions: '', description: '', tools: new Set() };
  const adapters = ['claude-code', 'antigravity-cli', 'mock'];
  // b.model is offered, though not listed first: it still wins.
  applyBoilerplate(st, gemini, { ...config, adapters, backends: { 'antigravity-cli': { models: ['gemini-2.5-pro', 'gemini-3.8-flash-high'] } } });
  assert.deepEqual([st.bp, st.backend, st.model, st.effort], ['bp-gemini', 'antigravity-cli', GEMINI_MODEL, 'high']);
  assert.deepEqual([...st.tools], ['shell', 'web.fetch']);
  // A Claude model is listed first, and b.model isn’t offered: the first gemini-* model wins.
  applyBoilerplate(st, gemini, { ...config, adapters, backends: { 'antigravity-cli': { models: ['claude-sonnet-4-6', 'gemini-2.5-pro'] } } });
  assert.deepEqual([st.backend, st.model, st.effort], ['antigravity-cli', 'gemini-2.5-pro', 'medium']);
  // Only a GPT-OSS model is offered, with no gemini-* model at all: it falls back to b.model.
  applyBoilerplate(st, gemini, { ...config, adapters, backends: { 'antigravity-cli': { models: ['gpt-oss-120b-medium'] } } });
  assert.deepEqual([st.backend, st.model, st.effort], ['antigravity-cli', GEMINI_MODEL, 'high']);
  // Switching back to a generic boilerplate restores the default backend, model and effort.
  applyBoilerplate(st, critic, { ...config, adapters, backends: { 'antigravity-cli': {} } });
  assert.deepEqual([st.bp, st.backend, st.model, st.effort], ['bp-critic', 'claude-code', DEFAULT_MODEL, DEFAULT_EFFORT]);
});

test('unavailable backend boilerplates are disabled with a reason, and switching backend by hand resets incompatible models', () => {
  const gemini = BOILERPLATES.find((b) => b.id === 'bp-gemini');
  const st = { bp: 'bp-critic', backend: 'claude-code', model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, instructions: '', description: '', tools: new Set() };
  // Without antigravity-cli installed, the boilerplate is unavailable and doesn’t apply onto Claude.
  assert.equal(boilerplateUnavailable(gemini, { adapters: ['claude-code', 'mock'] }), 'Antigravity CLI not on this computer');
  assert.equal(applyBoilerplate(st, gemini, { ...config, adapters: ['claude-code', 'mock'] }), false);
  assert.equal(st.backend, 'claude-code');
  assert.equal(st.model, DEFAULT_MODEL);
  // Picking Gemini and then switching Runs on to Claude Code by hand resets both model and effort.
  const cfg = { ...config, adapters: ['claude-code', 'antigravity-cli', 'kiro-cli', 'mock'], backends: { 'antigravity-cli': {} } };
  applyBoilerplate(st, gemini, cfg);
  assert.deepEqual([st.backend, st.model, st.effort], ['antigravity-cli', GEMINI_MODEL, 'high']);
  selectBackend(st, 'claude-code', cfg);
  assert.deepEqual([st.backend, st.model, st.effort], ['claude-code', DEFAULT_MODEL, DEFAULT_EFFORT]);
  // Switching from Claude Code with Sonnet selected to Kiro (which has no reported catalog) keeps Sonnet; switching from Antigravity to Kiro resets.
  st.model = 'claude-sonnet-5-5';
  st.effort = 'high';
  selectBackend(st, 'kiro-cli', cfg);
  assert.deepEqual([st.backend, st.model, st.effort], ['kiro-cli', 'claude-sonnet-5-5', 'high']);
  applyBoilerplate(st, gemini, cfg);
  selectBackend(st, 'kiro-cli', cfg);
  assert.deepEqual([st.backend, st.model, st.effort], ['kiro-cli', DEFAULT_MODEL, DEFAULT_EFFORT]);
  // A backend without a reported catalog (such as kiro-cli) keeps its own custom model when re-selected.
  st.backend = 'kiro-cli';
  st.model = 'gpt-5.6-terra';
  selectBackend(st, 'kiro-cli', cfg);
  assert.equal(st.model, 'gpt-5.6-terra');
});
