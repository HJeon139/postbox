// #503: Claude Code message content can be a string after compaction, not only an array of content blocks.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { contentBlocks, entriesToItems } from '../server/adapters/terminal-mirror.mjs';

const compact = readFileSync(new URL('fixtures/claude-code/compact.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

const context = () => ({
  persona: { model: 'claude-opus-5-5' },
  text() {},
  activity() {},
  status() {},
  compaction() {},
  reported() {},
  commands() {},
  toolUse() {},
  toolResult() {},
  taskEnded() {},
  usage() {},
  denied() {},
});

test('#503 content blocks keep arrays, turn a string into one text block, and reject other shapes', () => {
  const blocks = [{ type: 'tool_use', id: 'tool-1' }];
  assert.equal(contentBlocks(blocks), blocks);
  assert.deepEqual(contentBlocks('Compacted.'), [{ type: 'text', text: 'Compacted.' }]);
  assert.deepEqual(contentBlocks({ type: 'text', text: 'not an array' }), []);
});

test('#503 the recorded compact stream maps every event without a content-shape error', () => {
  const mapper = createStreamMapper(context());
  const errors = [];
  for (const event of compact) {
    try {
      mapper.push(event);
    } catch (error) {
      errors.push(`Postbox couldn’t read a Claude Code event: ${error.message}`);
    }
  }
  assert.deepEqual(errors, []);
});

test('#503 terminal history treats string assistant content as one text block, not characters', () => {
  assert.deepEqual(entriesToItems([{ type: 'assistant', message: { content: 'Compaction finished.' } }]), [
    { kind: 'agent', text: 'Compaction finished.', steps: [] },
  ]);
});
