// The model a backend starts with (shared/agent-facts.mjs, modelDefault, #390): one rule for the New agent sheet, the
// server’s persona with no model (personas.mjs) and an Antigravity turn (agyModel). Postbox’s default while the
// backend lists it; else auto, the harness’s own choice, when it lists that; else the backend’s preferred model
// (capabilities.preferModel); else the first it lists.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { AGY_CAPABILITIES, AntigravityCliAdapter, agyModel } from '../server/adapters/antigravity-cli.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { DEFAULT_MODEL } from '../server/adapters/setup.mjs';
import { Runtime } from '../server/runtime.mjs';
import { BOILERPLATES } from '../server/seed.mjs';
import { Store } from '../server/store.mjs';
import { AGY_DEFAULT_MODEL, applyBoilerplate, modelDefault, selectBackend } from '../shared/agent-facts.mjs';
import { tempDir } from './temp-dirs.mjs';

/** The page’s config with one backend’s capabilities, as /api/state serves them. */
const config = (backend, caps) => ({ defaultModel: DEFAULT_MODEL, defaultEffort: 'medium', backends: { [backend]: caps } });
const AGY = (models) => config('antigravity-cli', { ...AGY_CAPABILITIES, ...(models ? { models } : {}) });

test('#390 Antigravity listing a Claude model first starts on Gemini’s default, not the Claude model', () => {
  assert.equal(modelDefault('antigravity-cli', AGY(['claude-sonnet-4-6', 'gemini-2.5-pro', AGY_DEFAULT_MODEL])), AGY_DEFAULT_MODEL);
});

test('#390 Antigravity without Gemini’s default starts on its first Gemini model, then its first model', () => {
  assert.equal(modelDefault('antigravity-cli', AGY(['claude-sonnet-4-6', 'gemini-4-argon-medium'])), 'gemini-4-argon-medium');
  assert.equal(modelDefault('antigravity-cli', AGY(['gpt-oss-120b-medium'])), 'gpt-oss-120b-medium');
  assert.equal(modelDefault('antigravity-cli', AGY(null)), AGY_DEFAULT_MODEL, 'before agy has listed');
});

test('Codex, which never lists Postbox’s default, starts on auto, its own default, in the sheet too', () => {
  assert.equal(modelDefault('codex', config('codex', { models: ['gpt-6.1-sol', 'gpt-5.6-terra', 'auto'] })), 'auto');
  const st = { backend: 'claude-code', model: DEFAULT_MODEL, effort: 'medium', modelDefaulted: true };
  selectBackend(st, 'codex', config('codex', { models: ['gpt-6.1-sol', 'auto'] }));
  assert.equal(st.model, 'auto');
});

test('Claude Code starts on Postbox’s default while it lists it, else on the first it lists', () => {
  assert.equal(modelDefault('claude-code', config('claude-code', { models: ['claude-fable-5-2', DEFAULT_MODEL] })), DEFAULT_MODEL);
  assert.equal(modelDefault('claude-code', config('claude-code', { models: ['claude-opus-6', 'claude-sonnet-6'] })), 'claude-opus-6');
});

test('#390 the server’s Antigravity persona with no model gets the same model the sheet would', () => {
  const workRoot = join(tempDir('pb-model-default-'), 'workspaces');
  const agy = new AntigravityCliAdapter({ bin: 'agy', workRoot, settingsFile: join(workRoot, 'agy.json') });
  agy.capabilities = { ...agy.capabilities, models: ['claude-sonnet-4-6', 'gemini-4-argon-medium'] };
  const adapters = new AdapterRegistry().register(agy).register(new CodexAdapter({ bin: 'codex', workRoot }));
  const rt = new Runtime({ store: new Store(null), adapters, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 } });
  assert.equal(rt.createPersona({ handle: 'gem', backend: 'antigravity-cli' }).model, 'gemini-4-argon-medium');
  assert.equal(rt.createPersona({ handle: 'gpt', backend: 'codex' }).model, 'auto');
});

test('#390 an Antigravity turn on Claude’s default runs the same model', () => {
  assert.equal(agyModel({ model: DEFAULT_MODEL }, ['claude-sonnet-4-6', 'gemini-4-argon-medium']), 'gemini-4-argon-medium');
});

test('#390 the built-in GPT and Gemini boilerplates start on the model a new agent of their backend starts on', () => {
  const bp = (id) => BOILERPLATES.find((b) => b.id === id);
  const opened = (b, cfg) => {
    const st = { backend: 'claude-code', model: DEFAULT_MODEL, effort: 'medium' };
    applyBoilerplate(st, b, { ...cfg, adapters: Object.keys(cfg.backends) });
    return st.model;
  };
  const codex = config('codex', { models: ['gpt-6.1-sol', 'auto'] });
  assert.equal(opened(bp('bp-gpt'), codex), modelDefault('codex', codex), 'Codex’s default, auto');
  const agy = AGY(['claude-sonnet-4-6', 'gemini-4-argon-medium']);
  assert.equal(opened(bp('bp-gemini'), agy), modelDefault('antigravity-cli', agy));
});
