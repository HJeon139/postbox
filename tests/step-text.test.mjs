// A step as a turn reports it (server/step-text.mjs, turnStep): what it keeps of what its harness gave.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolOf, turnStep } from '../server/step-text.mjs';

test('a tool call’s step keeps the tool its harness ran in UAT recording mode, so the record can name it', () => {
  // As server/harness-tools.mjs starts a call’s step: its label, and the tool’s name.
  const was = process.env.POSTBOX_UAT_RECORD;
  process.env.POSTBOX_UAT_RECORD = '1';
  try {
    const step = turnStep({ id: 'toolu_1', label: 'Print CLAUDE_EFFORT environment variable', tool: 'Bash', state: 'running' });
    assert.equal(step.tool, 'Bash');
    assert.equal(turnStep({ id: 'thought-1', label: 'Thinking', state: 'done', kind: 'thought' }).tool, undefined);
  } finally {
    if (was === undefined) delete process.env.POSTBOX_UAT_RECORD;
    else process.env.POSTBOX_UAT_RECORD = was;
  }
});

test('outside UAT recording mode no step names its tool, so a room’s steps cost what they did (#1527)', () => {
  assert.deepEqual(toolOf('Bash', {}), {});
  assert.deepEqual(toolOf('Bash', { POSTBOX_UAT_RECORD: '0' }), {});
  assert.deepEqual(toolOf('Bash', { POSTBOX_UAT_RECORD: '1' }), { tool: 'Bash' });
});
