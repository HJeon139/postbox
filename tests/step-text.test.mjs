// A step as a turn reports it (server/step-text.mjs, turnStep): what it keeps of what its harness gave.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnStep } from '../server/step-text.mjs';

test('a tool call’s step keeps the tool its harness ran, so the record can name it', () => {
  // As server/harness-tools.mjs starts a call’s step: its label, and the tool’s name.
  const step = turnStep({ id: 'toolu_1', label: 'Print CLAUDE_EFFORT environment variable', tool: 'Bash', state: 'running' });
  assert.equal(step.tool, 'Bash');
  assert.equal(turnStep({ id: 'thought-1', label: 'Thinking', state: 'done', kind: 'thought' }).tool, undefined);
});
