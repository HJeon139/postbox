// Outside UAT recording mode, which is every room but a UAT run’s, no step names its tool (server/step-text.mjs,
// stepTool; #1527, the owner’s decision): not a turn’s steps, a refused Postbox tool’s step, nor an attached terminal’s
// steps, which the mirrors make without turnStep. The mode is cleared here, in case this runs under a UAT Postbox.

import assert from 'node:assert/strict';
import { test } from 'node:test';

delete process.env.POSTBOX_UAT_RECORD;
const { harnessSteps, historySteps, keptStep, mirroredSteps } = await import('./step-tool-fixture.mjs');

test('no step of a turn names its tool outside UAT recording mode', () => {
  assert.equal('tool' in keptStep(), false);
  const { started, denied } = harnessSteps();
  assert.equal('tool' in started, false);
  assert.equal(denied.length, 1);
  assert.equal('tool' in denied[0], false);
});

test('no step of an attached terminal names its tool outside UAT recording mode, mirrored or in its history', async () => {
  assert.deepEqual(
    historySteps().filter((s) => 'tool' in s),
    [],
  );
  const mirrored = await mirroredSteps();
  assert.equal(mirrored.length, 1);
  assert.deepEqual(
    mirrored.filter((s) => 'tool' in s),
    [],
  );
});
