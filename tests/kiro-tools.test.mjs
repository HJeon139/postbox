// The tool a Kiro call stands for (server/adapters/kiro-tools.mjs). The lines in
// tests/fixtures/kiro-tools/postbox-tool-titled.jsonl are a view_app call and its result, recorded from the Kiro CLI in
// a UAT run of 23 November 2026 (wikisearch-kiro): that CLI names the server in _meta and the tool only in the title.
// Two updates, not a whole turn, so they sit apart from the turns in tests/fixtures/kiro-cli that the golden replays.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { toolOf } from '../server/adapters/kiro-tools.mjs';
import { isQuietTool } from '../server/tool-labels.mjs';

const [CALL] = readFileSync(new URL('fixtures/kiro-tools/postbox-tool-titled.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l).data.update);

test('a Postbox tool that Kiro names only in the call’s title is read as Postbox’s tool, with its input', () => {
  assert.equal(CALL.title, '@postbox/view_app');
  assert.deepEqual(toolOf(CALL), { name: 'mcp__postbox__view_app', input: { appId: 'wiki-search-options' } });
});

test('#1591: a reaction and a read that Kiro names in the title stay quiet, so neither shows as a step of work', () => {
  // The recorded call, with the title of each tool an agent ends an exchange with or reads the room with.
  for (const tool of ['react', 'read_message', 'read_conversation']) {
    const { name } = toolOf({ ...CALL, title: `@postbox/${tool}` });
    assert.equal(name, `mcp__postbox__${tool}`);
    assert.equal(isQuietTool(name), true, `${tool} shows as a step`);
  }
});

test('a title that names another server than the call’s, or no tool, keeps Kiro’s title', () => {
  assert.equal(toolOf({ ...CALL, title: '@other/react' }).name, null);
  assert.equal(toolOf({ ...CALL, title: 'Reading a file' }).name, null);
  assert.equal(toolOf({ title: '@postbox/react', rawInput: {} }).name, null, 'no server named, so the title alone names nothing');
});
