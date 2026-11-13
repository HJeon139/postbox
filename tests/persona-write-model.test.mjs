// The model a new persona gets when it names none (server/persona-write.mjs): Postbox’s default while the backend
// offers it, else what the backend’s harness listed (server/model-lists.mjs).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { DEFAULT_MODEL } from '../server/adapters/setup.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

function setup(claudeModels) {
  const workRoot = join(tempDir('pb-persona-model-'), 'workspaces');
  const claude = new ClaudeCodeAdapter({ bin: 'claude', workRoot });
  if (claudeModels) claude.capabilities = { ...claude.capabilities, models: claudeModels };
  const adapters = new AdapterRegistry().register(claude).register(new CodexAdapter({ bin: 'codex', workRoot }));
  return new Runtime({ store: new Store(null), adapters, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 } });
}

test('a Claude Code persona that names no model gets Postbox’s default before Claude Code has listed its models', () => {
  assert.equal(setup(null).createPersona({ handle: 'alpha', backend: 'claude-code' }).model, DEFAULT_MODEL);
});

test('a Claude Code persona that names no model gets the first model Claude Code lists, once its list has moved on from Postbox’s default', () => {
  const rt = setup(['claude-opus-6', 'claude-sonnet-6']);
  assert.equal(rt.createPersona({ handle: 'alpha', backend: 'claude-code' }).model, 'claude-opus-6');
});

test('a Codex persona that names no model still gets auto, Codex’s own default', () => {
  assert.equal(setup(null).createPersona({ handle: 'alpha', backend: 'codex' }).model, 'auto');
});

test('a model the persona names is kept, listed or not', () => {
  const rt = setup(['claude-opus-6']);
  assert.equal(rt.createPersona({ handle: 'alpha', backend: 'claude-code', model: 'my-gateway/claude-custom' }).model, 'my-gateway/claude-custom');
});
