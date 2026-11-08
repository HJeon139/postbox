// A host's shim and a queued tool call (#827, #792): the call waits for the daemon's verdict, which comes after the
// daemon's own checks and its record of the call, so a refusal reaches the agent in its own call. The shim's other
// tool calls are tests/integration/remote-shim.test.mjs's.

import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, sleep, textOf } from './remote-shim-fixtures.mjs';

const LATER = 'If Postbox refuses it, you’ll hear why at your next turn.';
const MAY_HAVE = 'It may have it anyway, so check the conversation before you call it again.';

test('#827 a queued call the daemon refuses returns the refusal as the tool’s error, in the daemon’s words', async (t) => {
  const { shim, daemon } = await setup(t);
  await daemon.connected();
  const id = shim.tool('show_app', { id: 'app_1', title: 'Chart', codePath: '../outside.html' });
  const call = await daemon.next('call');
  const why = 'show_app’s codePath ../outside.html is outside this turn’s folder.';
  daemon.send('result', { id: call.id, ok: false, text: why });
  const res = await shim.response(id);
  assert.equal(res.result.isError, true);
  assert.equal(textOf(res), why);
});

test('#827 a queued call is answered once the daemon has taken it, not before, and the answer says a refusal comes later', async (t) => {
  const { shim, daemon } = await setup(t);
  await daemon.connected();
  const id = shim.tool('show_app', { title: 'Chart', code: '<p>Hi</p>' });
  const call = await daemon.next('call');
  await sleep(100);
  assert.equal(
    shim.out.find((m) => m.id === id),
    undefined,
    'no answer before the daemon’s',
  );
  daemon.send('result', { id: call.id, ok: true, text: 'Queued for Postbox.' });
  const res = await shim.response(id);
  assert.equal(res.result.isError, undefined);
  // The id the shim gave the app is still named, so the agent can update it.
  assert.equal(
    textOf(res),
    `Sent app ${call.args.id} to Postbox, which checks it and shows it as soon as it’s connected to this host. Use that id to update it. ${LATER}`,
  );
});

test('#827 a queued call waiting when the daemon says the turn ended is refused with its reason', async (t) => {
  const { shim, daemon } = await setup(t);
  await daemon.connected();
  const id = shim.tool('define_term', { term: 'shim', definition: 'The host’s MCP server.' });
  await daemon.next('call');
  daemon.send('error', { code: 'turn-ended', message: 'Turn turn-shim-1 has ended.' });
  const res = await shim.response(id);
  assert.equal(res.result.isError, true);
  assert.equal(textOf(res), 'Postbox’s daemon on this host refused define_term: Turn turn-shim-1 has ended.');
});

test('#827 with the daemon unreachable, a queued call fails after the wait, says it may still arrive, and isn’t sent later', async (t) => {
  const { shim, daemon } = await setup(t, { startDaemon: false, timings: { unreachable: 300, backoff: 20, backoffMax: 50 } });
  const res = await shim.response(shim.tool('define_term', { term: 'shim', definition: 'The host’s MCP server.' }));
  assert.equal(res.result.isError, true);
  assert.match(textOf(res), /^Postbox’s daemon on this host didn’t take define_term within /);
  assert.ok(textOf(res).includes(MAY_HAVE), textOf(res));
  await daemon.start();
  await daemon.next('hello');
  await sleep(100);
  assert.equal(daemon.received.filter((m) => m.type === 'call').length, 0, 'a call refused to its agent isn’t sent afterwards');
});

test('#827 a queued call the daemon never answers fails after the wait, and a late answer sends nothing more', async (t) => {
  const { shim, daemon } = await setup(t, { timings: { unreachable: 300 } });
  await daemon.connected();
  const id = shim.tool('define_term', { term: 'shim', definition: 'The host’s MCP server.' });
  const call = await daemon.next('call');
  const res = await shim.response(id);
  assert.equal(res.result.isError, true);
  assert.match(textOf(res), /^Postbox’s daemon on this host didn’t take define_term within /);
  assert.ok(textOf(res).includes(MAY_HAVE), textOf(res));
  daemon.send('result', { id: call.id, ok: false, text: 'Too late.' });
  await sleep(100);
  assert.equal(shim.out.filter((m) => m.id === id).length, 1, 'one answer per call');
});
