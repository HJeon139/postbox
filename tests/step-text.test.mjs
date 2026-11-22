// A step’s tool (server/step-text.mjs, stepTool): set only in UAT recording mode, and only for a tool call. The
// mode itself is read once, when the module loads (tests/step-tool-on.test.mjs and step-tool-off.test.mjs run it).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepTool } from '../server/step-text.mjs';
import { uatRecording } from '../server/uat-mode.mjs';

test('a step names its tool only in UAT recording mode, and only when it has one, bounded as a label is', () => {
  assert.deepEqual(stepTool('Bash', true), { tool: 'Bash' });
  assert.deepEqual(stepTool('Bash', false), {});
  assert.deepEqual(stepTool(undefined, true), {});
  assert.deepEqual(stepTool('', true), {});
  assert.equal(stepTool('x'.repeat(300), true).tool.length, 200);
});

test('UAT recording mode is POSTBOX_UAT_RECORD=1 and nothing else', () => {
  assert.equal(uatRecording({ POSTBOX_UAT_RECORD: '1' }), true);
  for (const v of [undefined, '', '0', 'true', 'yes']) assert.equal(uatRecording({ POSTBOX_UAT_RECORD: v }), false, String(v));
});
