// #489: Kiro’s v3 engine gives the model MCP tools only on demand, through its own loader and tool_call, and nothing
// told a Kiro agent so: one agent with the loader in its list never loaded Postbox’s tools, and said they “were never
// available to call”. Kiro has named its loader two ways, each in a recorded turn: `tool_load`, taking `tool_ids` such
// as `postbox::show_block` (block.jsonl, an early kiro-cli), and `load_resource`, taking an `id` such as
// `tool::postbox::show_block` (tool-load-deepseek.jsonl, kiro-cli 3.6.2 on deepseek-3.2, recorded 27 November 2026).
// The agent is told both, so it isn’t sent looking for a tool its Kiro doesn’t have.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { kiroAgent } from '../server/adapters/kiro-cli.mjs';

/** The recorded turn’s lines. @param {string} name */
const lines = (name) =>
  readFileSync(new URL(`fixtures/kiro-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
/** The recorded turn’s Tool Load step’s input. @param {string} name */
const loadOf = (name) => lines(name).find((e) => e.data?.update?.title === 'Tool Load')?.data.update.rawInput;
/** The tools the recorded turn says it used. @param {string} name */
const usedOf = (name) => lines(name).find((e) => e.data?.update?._meta?.kiro?.promptTurnSummaries)?.data.update._meta.kiro.promptTurnSummaries[0].usedTools;

/** The prompt a Kiro agent gets, Shared or Isolated. @param {boolean} usesHostSetup */
const promptFor = (usesHostSetup) =>
  kiroAgent({ name: 'x', persona: { handle: 'kiro', model: 'claude-opus-5-5', usesHostSetup, tools: [] }, mcpUrl: '', guide: '', folders: [] }).prompt;

test('#489: the two recorded loaders, as the note names them', () => {
  assert.deepEqual(loadOf('block'), { tool_ids: ['postbox::show_block'] });
  assert.deepEqual(usedOf('isolated-deny'), ['tool_load', 'tool_call']);
  assert.deepEqual(loadOf('tool-load-deepseek'), { id: 'tool::postbox::show_block' });
  assert.deepEqual(usedOf('tool-load-deepseek'), ['load_resource', 'tool_call']);
  // The model the turn ran on: the last setting Kiro reported before the turn started (the first is its default).
  const recorded = lines('tool-load-deepseek');
  const start = recorded.findIndex((e) => e.data?.update?._meta?.kiro?.kind === 'turn_start');
  const set = recorded
    .slice(0, start)
    .flatMap((e) => e.data?.update?.configOptions ?? [])
    .filter((o) => o.id === 'model');
  assert.equal(set.at(-1)?.currentValue, 'deepseek-3.2');
});

test('#489: a Kiro agent is told Postbox’s tools load on demand, by either loader, with ids in the form each takes', () => {
  for (const usesHostSetup of [true, false]) {
    const prompt = promptFor(usesHostSetup);
    // Each id in backticks, as the note sets it, so the shorter form isn’t found inside the longer.
    for (const said of ['`load_resource`', '`tool::postbox::show_block`', '`tool_load` with `postbox::show_block`', '`tool_call`'])
      assert.ok(prompt.includes(said), `usesHostSetup ${usesHostSetup}: ${said}`);
  }
});
