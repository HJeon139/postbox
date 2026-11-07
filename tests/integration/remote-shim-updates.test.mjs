// A host's shim and update_block (#854): which updates it checks in the call, and which it leaves to the daemon.
// The shim's other tool calls are tests/integration/remote-shim.test.mjs's.

import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, sleep, textOf } from './remote-shim-fixtures.mjs';

test('#854 an invalid whole-block update_block is refused in the call; an outcome, a withdraw and a valid one are sent', async (t) => {
  const { shim, daemon } = await setup(t);
  await daemon.connected();
  const refused = await shim.response(shim.tool('update_block', { block: { id: 'pick', type: 'choice', version: 1 } }));
  assert.equal(refused.result.isError, true);
  assert.match(textOf(refused), /^The update was invalid and wasn’t applied: .*fallback is required/);
  // An app review is a block like any other: its shape is checked here.
  const review = await shim.response(shim.tool('update_block', { block: { id: 'rv', type: 'review', version: 1, fallback: 'Review', format: 'app' } }));
  assert.match(textOf(review), /^The update was invalid and wasn’t applied: An app review needs appId\./);
  // Postbox checks an outcome or a withdraw against the block it names, and an image’s origin against its own list.
  const image = { id: 'img', type: 'image', version: 1, fallback: 'A cover', src: 'https://upload.wikimedia.org/a.png', alt: 'A cover' };
  const sent = [{ id: 'pick', outcome: 'Filed as #1' }, { id: 'pick', withdraw: 'Stale.' }, image];
  for (const block of sent) assert.equal((await shim.response(shim.tool('update_block', { block }))).result.isError, undefined);
  const calls = [await daemon.next('call'), await daemon.next('call', 1), await daemon.next('call', 2)];
  assert.deepEqual(
    calls.map((c) => c.args.block),
    sent,
  );
  await sleep(50);
  assert.equal(daemon.received.filter((m) => m.type === 'call').length, 3, 'a refused update never reaches the daemon');
});

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
