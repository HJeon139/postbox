// #994’s two shim paths with no test: a queued call is answered once, whatever ends it. refuseAll settles a queued
// call it refuses, so its wait timer can’t answer it a second time; and a harness cancel settles a queued call, so the
// daemon’s late result sends nothing. The other queued-call cases are remote-shim-queued.test.mjs’s.

import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, sleep } from './remote-shim-fixtures.mjs';

const CANCEL = 'notifications/cancelled'; // lint-allow spelling: the MCP protocol’s method name.

test('#994 a queued call refused because the turn ended is answered once, not again when its wait runs out', async (t) => {
  const { shim, daemon } = await setup(t, { timings: { unreachable: 300 } });
  await daemon.connected();
  const id = shim.tool('define_term', { term: 'shim', definition: 'The host’s MCP server.' });
  await daemon.next('call');
  daemon.send('error', { code: 'turn-ended', message: 'Turn turn-shim-1 has ended.' });
  await shim.response(id);
  await sleep(600);
  assert.equal(shim.out.filter((m) => m.id === id).length, 1, 'one answer, though the 300 ms wait has passed');
});

test('#994 a queued call the harness cancels gets no answer, and the daemon’s late result sends nothing', async (t) => {
  const { shim, daemon } = await setup(t);
  await daemon.connected();
  const id = shim.tool('show_app', { title: 'Chart', code: '<p>Hi</p>' });
  const call = await daemon.next('call');
  shim.write({ jsonrpc: '2.0', method: CANCEL, params: { requestId: id, reason: 'The user stopped the turn.' } });
  await sleep(50);
  daemon.send('result', { id: call.id, ok: true, text: 'Queued for Postbox.' });
  await sleep(100);
  assert.equal(shim.out.filter((m) => m.id === id).length, 0, 'the client gave up on it, so it gets no response');
});
