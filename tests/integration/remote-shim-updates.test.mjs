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
  const calls = [];
  for (const block of sent) {
    const id = shim.tool('update_block', { block });
    const call = await daemon.next('call', calls.length);
    calls.push(call);
    // A queued call is answered once the daemon has taken it (#827).
    daemon.send('result', { id: call.id, ok: true, text: 'Queued for Postbox.' });
    assert.equal((await shim.response(id)).result.isError, undefined);
  }
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

test('#1319 an invalid show_block is refused in the call, as an update is; a valid one, and an app whose intent is long, are sent', async (t) => {
  const { shim, daemon } = await setup(t);
  await daemon.connected();
  const refused = await shim.response(shim.tool('show_block', { block: { id: 'pick', type: 'choice', version: 1, options: ['Yes', 'No'] } }));
  assert.equal(refused.result.isError, true);
  assert.match(textOf(refused), /^The block wasn’t shown: .*fallback is required\..*A choice block looks like this: \{/);
  // Postbox trims an app’s intent rather than refusing it (#995), so the host doesn’t refuse it either.
  const app = { id: 'chart', type: 'app', version: 1, fallback: 'A chart', code: '<p>Hi</p>', intent: 'word '.repeat(400) };
  const choice = { id: 'pick', type: 'choice', version: 1, fallback: 'Yes or no?', options: [{ id: 'yes', label: 'Yes' }] };
  const calls = [];
  for (const block of [choice, app]) {
    const id = shim.tool('show_block', { block });
    const call = await daemon.next('call', calls.length);
    calls.push(call);
    daemon.send('result', { id: call.id, ok: true, text: 'Queued for Postbox.' });
    assert.equal((await shim.response(id)).result.isError, undefined);
  }
  assert.deepEqual(
    calls.map((c) => c.args.block.id),
    ['pick', 'chart'],
  );
});
