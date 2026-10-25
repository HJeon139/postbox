import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { createCodexMapper } from '../server/adapters/codex.mjs';
import { agyContextPercent, agyWindowFor, codexContextPercent, codexWindowFor } from '../server/adapters/context-usage.mjs';

test('Antigravity resolves context windows and calculates active context percentage', () => {
  assert.equal(agyWindowFor('gemini-3.8-flash'), 1_000_000);
  assert.equal(agyWindowFor('gemini-3.8-flash-high'), 1_000_000);
  assert.equal(agyWindowFor('gemini-1.5-pro'), 2_000_000);
  assert.equal(agyWindowFor('unknown-model'), null);

  assert.equal(agyContextPercent({ input_tokens: 10_000, cache_read_tokens: 0 }, 1_000_000), 1);
  assert.equal(agyContextPercent({ input_tokens: 25_000, cache_read_tokens: 225_000 }, 1_000_000), 25);
  assert.equal(agyContextPercent(null, 1_000_000), null);
  assert.equal(agyContextPercent({ input_tokens: 100 }, null), null);
});

test('Codex resolves fallback context windows and calculates active context percentage', () => {
  assert.equal(codexWindowFor('gpt-6.1-sol'), 475_000);
  assert.equal(codexWindowFor('gpt-5.6-terra'), 475_000);
  assert.equal(codexWindowFor('gpt-4o'), 128_000);
  assert.equal(codexWindowFor('o3-mini'), 200_000);
  assert.equal(codexWindowFor('claude-opus-5-5'), null);

  assert.equal(codexContextPercent({ inputTokens: 47_500 }, 475_000), 10);
  assert.equal(codexContextPercent({ input_tokens: 95_000 }, 475_000), 20);
  assert.equal(codexContextPercent(null, 475_000), null);
});

test('Antigravity mapper emits ctx status from step_update usage', () => {
  const statusUpdates = [];
  const ctx = {
    status: (patch) => statusUpdates.push(patch),
    activity: () => {},
    text: () => {},
    persona: { model: 'gemini-3.8-flash-high' },
  };
  const mapper = createAgyMapper(ctx);
  mapper.push({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      usage: { input_tokens: 50_000, cache_read_tokens: 50_000 },
    },
  });

  const ctxUpdates = statusUpdates.filter((x) => typeof x.ctx === 'number');
  assert.equal(ctxUpdates.length, 1);
  assert.equal(ctxUpdates[0].ctx, 10);
});

test('Codex mapper emits ctx status from thread/tokenUsage/updated notifications', () => {
  const statusUpdates = [];
  const ctx = {
    status: (patch) => statusUpdates.push(patch),
    activity: () => {},
    text: () => {},
    persona: { model: 'gpt-6.1-sol' },
  };
  const mapper = createCodexMapper(ctx);
  mapper.push({
    method: 'thread/tokenUsage/updated',
    params: {
      tokenUsage: { inputTokens: 95_000 },
      modelContextWindow: 475_000,
    },
  });

  const ctxUpdates = statusUpdates.filter((x) => typeof x.ctx === 'number');
  assert.equal(ctxUpdates.length, 1);
  assert.equal(ctxUpdates[0].ctx, 20);
});
