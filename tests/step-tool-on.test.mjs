// In UAT recording mode every tool call’s step names the tool it ran (server/step-text.mjs, stepTool; #1527): a
// turn’s steps, a refused Postbox tool’s only step, and an attached Claude Code terminal’s steps, mirrored or brought
// as its history. Each test file runs in its own process, so the mode set here is this file’s alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.POSTBOX_UAT_RECORD = '1';
const { harnessSteps, historySteps, keptStep, mirroredSteps } = await import('./step-tool-fixture.mjs');

test('a tool call’s step keeps the tool its harness ran, so the record can name it', () => {
  assert.equal(keptStep().tool, 'Bash');
  assert.equal(harnessSteps().started.tool, 'Bash');
});

test('a refused Postbox tool’s step names the tool, though its call showed no step of its own', () => {
  for (const refusedAfter of [false, true]) {
    const { denied } = harnessSteps({ refusedAfter });
    assert.deepEqual(
      denied.map((s) => s.tool),
      ['mcp__postbox__show_block'],
      `refused after its result: ${refusedAfter}`,
    );
  }
});

test('an attached terminal’s steps name their tool, in its history and as the mirror brings them', async () => {
  assert.deepEqual(
    historySteps().map((s) => [s.id, s.tool]),
    [['toolu_r', 'Read']],
  );
  assert.deepEqual(
    (await mirroredSteps()).map((s) => [s.id, s.tool]),
    [['toolu_r', 'Read']],
  );
});
