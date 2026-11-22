// #489: Kiro’s v3 engine gives the model MCP tools only on demand, through its own tool_load and tool_call, and nothing
// told a Kiro agent so: one agent with tool_load in its list never loaded Postbox’s tools, and said they “were never
// available to call”. The ids are the ones Kiro’s Tool Load step took in a recorded turn (block.jsonl).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { kiroAgent } from '../server/adapters/kiro-cli.mjs';

const loaded = readFileSync(new URL('fixtures/kiro-cli/block.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l).data?.update)
  .find((u) => u?.title === 'Tool Load')?.rawInput?.tool_ids;

test('#489: a Kiro agent is told Postbox’s tools load on demand, and how to load one', () => {
  assert.deepEqual(loaded, ['postbox::show_block'], 'the recorded turn loaded a tool by its namespaced id');
  for (const usesHostSetup of [true, false]) {
    const persona = { handle: 'kiro', model: 'claude-opus-5-5', usesHostSetup, tools: [] };
    const { prompt } = kiroAgent({ name: 'x', persona, mcpUrl: '', guide: '', folders: [] });
    assert.match(prompt, /tool_load/, `usesHostSetup ${usesHostSetup}`);
    assert.ok(prompt.includes(loaded[0]), 'with an id in the form Kiro takes');
    assert.match(prompt, /tool_call/);
  }
});
