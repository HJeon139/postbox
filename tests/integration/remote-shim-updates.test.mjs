// A host's shim and update_block (#854): which updates it checks in the call, and which it leaves to the daemon.
// The shim's other tool calls are tests/integration/remote-shim.test.mjs's.

import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './remote-shim-fixtures.mjs';

test('#854 an update_block carrying a review’s files isn’t checked in the call: it waits for the daemon, which takes the files off first', async (t) => {
  const { shim, daemon } = await setup(t);
  await daemon.connected();
  const block = {
    id: 'rv',
    type: 'review',
    version: 1,
    fallback: 'A draft',
    format: 'markdown',
    content: '![Chart](chart.png)',
    files: [{ path: 'chart.png' }],
  };
  shim.tool('update_block', { block });
  const call = await daemon.next('call');
  assert.deepEqual(call.args.block, block, 'sent to the daemon, not refused for its files');
});
