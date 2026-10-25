// What an agent runs with, in words (#60): the model that answered its last turn, marked when it differs from
// the setting, and the effort. The top bar, the overview card and the menus read these.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_EFFORT, DEFAULT_MODEL, effortOf, modelOf } from '../server/adapters/setup.mjs';
import { BOILERPLATES } from '../server/seed.mjs';
import { applyBoilerplate, chipEffort, chipModel, factsText, GEMINI_MODEL, installNote, runsWith, sameModel, shortModel } from '../shared/agent-facts.mjs';

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

test('picking the Gemini boilerplate selects the Antigravity CLI and its first reported model, or gemini-3.8-flash-high', () => {
  const gemini = BOILERPLATES.find((b) => b.id === 'bp-gemini');
  const critic = BOILERPLATES.find((b) => b.id === 'bp-critic');
  const st = { bp: 'bp-critic', backend: 'claude-code', model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, instructions: '', description: '', tools: new Set() };
  // With models reported by `agy models`, the first one wins.
  applyBoilerplate(st, gemini, {
    ...config,
    adapters: ['claude-code', 'antigravity-cli', 'mock'],
    backends: { 'antigravity-cli': { models: ['gemini-2.5-pro', 'gemini-3.8-flash-high'] } },
  });
  assert.equal(st.bp, 'bp-gemini');
  assert.equal(st.backend, 'antigravity-cli');
  assert.equal(st.model, 'gemini-2.5-pro');
  assert.equal(st.effort, 'medium');
  assert.deepEqual([...st.tools], ['shell', 'web.fetch']);
  // Without reported models, it falls back to gemini-3.8-flash-high and syncs effort to high.
  applyBoilerplate(st, gemini, { ...config, adapters: ['claude-code', 'antigravity-cli', 'mock'], backends: { 'antigravity-cli': {} } });
  assert.equal(st.backend, 'antigravity-cli');
  assert.equal(st.model, GEMINI_MODEL);
  assert.equal(st.effort, 'high');
  // Switching back to a generic boilerplate restores the default backend, model and effort.
  applyBoilerplate(st, critic, { ...config, adapters: ['claude-code', 'antigravity-cli', 'mock'], backends: { 'antigravity-cli': {} } });
  assert.equal(st.bp, 'bp-critic');
  assert.equal(st.backend, 'claude-code');
  assert.equal(st.model, DEFAULT_MODEL);
  assert.equal(st.effort, DEFAULT_EFFORT);
});
