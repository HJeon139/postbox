import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { createCodexMapper } from '../server/adapters/codex.mjs';
import { agyContextPercent, agyWindowFor, codexContextPercent } from '../server/adapters/context-usage.mjs';

test('Antigravity resolves cited context windows and calculates active context percentage with cache', () => {
  assert.equal(agyWindowFor('gemini-3.8-flash'), 1_000_000);
  assert.equal(agyWindowFor('gemini-3.8-flash-high'), 1_000_000);
  assert.equal(agyWindowFor('gemini-1.5-pro'), 2_000_000);
  assert.equal(agyWindowFor('gemini-2.0-flash'), 1_000_000);
  assert.equal(agyWindowFor('unknown-model'), null);

  // Uncached prompt only
  assert.equal(agyContextPercent({ input_tokens: 10_000, cache_read_tokens: 0 }, 1_000_000), 1);
  // Real agy step 245 evidence: 2,787 input_tokens + 23,525 cache_read_tokens = 26,312 prompt tokens
  assert.equal(agyContextPercent({ input_tokens: 2787, cache_read_tokens: 23525 }, 1_000_000), 3);
  assert.equal(agyContextPercent(null, 1_000_000), null);
  assert.equal(agyContextPercent({ input_tokens: 100 }, null), null);
});

test('Codex calculates active context percentage from reported modelContextWindow', () => {
  assert.equal(codexContextPercent(47_500, 475_000), 10);
  assert.equal(codexContextPercent(106_596, 475_000), 22);
  assert.equal(codexContextPercent(null, 475_000), null);
  assert.equal(codexContextPercent(10_000, null), null);
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

test('Codex mapper emits ctx status from thread/tokenUsage/updated with generated shape', () => {
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
      threadId: 'thr_1',
      turnId: 'turn_1',
      tokenUsage: {
        total: { totalTokens: 107088, inputTokens: 106596, cachedInputTokens: 103680, cacheWriteInputTokens: 0, outputTokens: 492, reasoningOutputTokens: 12 },
        last: { totalTokens: 107088, inputTokens: 106596, cachedInputTokens: 103680, cacheWriteInputTokens: 0, outputTokens: 492, reasoningOutputTokens: 12 },
        modelContextWindow: 475000,
      },
    },
  });

  const ctxUpdates = statusUpdates.filter((x) => typeof x.ctx === 'number');
  assert.equal(ctxUpdates.length, 1);
  assert.equal(ctxUpdates[0].ctx, 22);
});
