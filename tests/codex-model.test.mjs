// Unoffered Claude models use Codex’s default; explicit Codex model choices remain overrides.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexModelOverride } from '../server/adapters/codex-model.mjs';
import { DEFAULT_MODEL } from '../server/adapters/setup.mjs';

test('Codex omits Claude’s runtime fallback unless its catalog explicitly offers it', () => {
  assert.deepEqual(codexModelOverride({ model: DEFAULT_MODEL }), {});
  assert.deepEqual(codexModelOverride({ model: DEFAULT_MODEL }, []), {});
  assert.deepEqual(codexModelOverride({ model: DEFAULT_MODEL }, ['gpt-example']), {});
  assert.deepEqual(codexModelOverride({ model: DEFAULT_MODEL }, [DEFAULT_MODEL]), { model: DEFAULT_MODEL });
});

test('Codex retains explicit models, including unknown models so their errors remain visible', () => {
  assert.deepEqual(codexModelOverride({ model: 'gpt-example' }), { model: 'gpt-example' });
  assert.deepEqual(codexModelOverride({ model: 'gpt-nope' }, ['gpt-example']), { model: 'gpt-nope' });
  assert.deepEqual(codexModelOverride({ model: '' }), {});
  assert.deepEqual(codexModelOverride({ model: 'mock' }), {});
});

test('Codex omits inherited Claude models unless its catalog explicitly offers them', () => {
  for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
    assert.deepEqual(codexModelOverride({ model }), {});
    assert.deepEqual(codexModelOverride({ model }, ['gpt-example']), {});
    assert.deepEqual(codexModelOverride({ model }, [model]), { model });
  }
});
