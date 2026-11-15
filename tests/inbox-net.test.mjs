// The behavior net for the inbox’s step 2 (designs/architecture/services.md, “Delivery and Turns, built as the inbox”,
// and “Keep: the behavior net”): what an agent’s @-mention must still do once mentions become stored entries instead of
// wakes at the end of a turn. Each test acts through the facade and reads only what the woken agent’s turns were given,
// never how the hand-off travelled, so the switch keeps these as they are. Green on main before the switch.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { restarted, rig, starts, startUp, until } from './remote-turns-helpers.mjs';
import { held, ScriptedAdapter, settle, setup, sleep } from './side-threads-fixture.mjs';

/** Everything an agent’s turns were given, one string per turn, whatever shape each message had. */
const given = (adapter, sessionId) => adapter.calls.filter((c) => c.sessionId === sessionId).map((c) => JSON.stringify(c.message));

/** How many of an agent’s turns were given a text. */
const turnsWith = (adapter, sessionId, text) => given(adapter, sessionId).filter((m) => m.includes(text)).length;

test('an agent’s @-mention reaches the agent it names whole, in one turn, after the reply that wrote it', async () => {
  const { rt, adapter, t, beta } = setup();
  const hand = `@beta the index is rebuilt. ${'Every shard checked. '.repeat(200)}End of the hand-off.`;
  adapter.next.push(async (c) => c.text(hand));
  rt.sendMessage(t.id, { text: '@alpha rebuild the index' });
  await settle(rt);
  assert.equal(turnsWith(adapter, beta.id, 'End of the hand-off.'), 1, 'beta was given the whole reply once');
  assert.equal(turnsWith(adapter, beta.id, 'Every shard checked. '.repeat(200).trim()), 1, 'with nothing cut from its middle');
});

test('a mention of a busy agent waits for its turn to end, then reaches it whole', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  adapter.next.push(async (c) => c.text('@beta when you’re free: the 1908 edition differs.'));
  rt.sendMessage(t.id, { text: '@beta start the survey' });
  await sleep(5);
  rt.sendMessage(t.id, { text: '@alpha compare the editions' });
  await until(() => !arrange.running(rt, alpha.id), 'alpha’s turn to end');
  assert.equal(turnsWith(adapter, beta.id, 'the 1908 edition differs'), 0, 'nothing reaches beta mid-turn');
  busy.release();
  await settle(rt);
  assert.equal(turnsWith(adapter, beta.id, 'the 1908 edition differs'), 1, 'beta was given it once its turn ended');
});

test('#485: a failed reply’s mention still reaches the agent, and a Retry of it doesn’t hand the same work over again', async () => {
  const { store, rt, adapter, t, beta } = setup();
  adapter.next.push(async (c) => {
    c.text('#451 is ready. @beta please record it.');
    throw new Error('Claude Code exited with code 1.');
  });
  rt.sendMessage(t.id, { text: '@alpha report on #451' });
  await settle(rt);
  assert.equal(turnsWith(adapter, beta.id, '#451 is ready.'), 1, 'beta heard the failed reply’s hand-off');
  const failed = store.items(t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  adapter.next.push(async (c) => c.text('#451 is ready at 41f3a0f. @beta please record it.'));
  await rt.retry(t.id, failed.id);
  await settle(rt);
  assert.ok(
    store.items(t.id).some((i) => i.kind === 'agent' && i.status === 'done' && i.text.includes('41f3a0f')),
    'the retry answered',
  );
  assert.equal(turnsWith(adapter, beta.id, '41f3a0f'), 0, 'beta isn’t woken a second time for the same hand-off');
});

test('the person’s Stop ends what waited for the agent: the mention it hadn’t taken starts no turn after it', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  adapter.next.push(async (c) => c.text('@beta also check the 1912 edition.'));
  rt.sendMessage(t.id, { text: '@beta start the survey' });
  await sleep(5);
  rt.sendMessage(t.id, { text: '@alpha anything to add?' });
  await until(() => !arrange.running(rt, alpha.id), 'alpha’s turn to end');
  rt.stop(beta.id);
  busy.release();
  await settle(rt);
  assert.equal(turnsWith(adapter, beta.id, '1912 edition'), 0, 'the stopped agent wasn’t started by the mention');
});

test('#1135: a mention of an agent whose host turn waits to be attached after a restart waits for that turn, then reaches it', async () => {
  const { store, d } = restarted({ welcome: 'running' });
  const r = rig({ store, d });
  const local = new ScriptedAdapter();
  arrange.withAdapter(r.rt, local);
  const p = r.rt.createPersona({ handle: 'alpha' });
  r.rt.ensureSession(r.t.id, p.id);
  let release = () => {};
  const welcome = new Promise((res) => {
    release = res;
  });
  const ensure = r.hosts.ensureWelcome;
  r.hosts.ensureWelcome = async (/** @type {string} */ hostId) => {
    if (hostId === r.host.id) await welcome;
    return ensure(hostId);
  };
  startUp(r);
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the host turn to wait for its welcome');
  local.next.push(async (c) => c.text('@coder the tests pass on my side.'));
  r.rt.sendMessage(r.t.id, { text: '@alpha check the tests' });
  await until(() => local.calls.length === 1 && !r.rt.turns.size, 'alpha’s turn to end');
  await sleep(20);
  assert.equal(starts(d).length, 0, 'no second turn starts on the host beside the one to attach');
  release();
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach');
  d.end('host-turn-1');
  await until(() => starts(d).length === 1, 'the mention’s turn, once the attached one ends');
  assert.ok(JSON.stringify(starts(d)[0]).includes('the tests pass on my side'), 'the host agent was given the mention');
  d.end(starts(d)[0].turn);
  await until(() => !r.rt.turns.size && !r.rt.exiting.size, 'the turn to end');
});
