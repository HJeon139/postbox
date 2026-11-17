// The order of the listeners within one end-of-turn signal (designs/architecture/services.md, “The end of a turn”):
// on `turn.ended`, M (Apps) settles an app-check turn’s app before N (Asks) writes what the person needs, and N writes
// `open`, `viewing` and `topic` before P (Threads) reads them; the inbox’s R starts the agent’s entries before what
// waited on the turn when an entry came first (#733). turn-end-signals.test.mjs pins the order of the signals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

test('#1429 P reads the topic N found: a reply in a topic the person isn’t viewing counts there', async () => {
  const { rt, store, adapter, t } = setup();
  adapter.next.push(async (/** @type {any} */ c) => c.text('First answer.'));
  rt.sendMessage(t.id, { text: '@alpha first question' });
  await settle(rt);
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.text === 'First answer.');
  const topic = rt.startTopic(t.id, reply.id).threadId;
  rt.view(null);
  adapter.next.push(async (/** @type {any} */ c) => c.text('Offsets win.'));
  rt.sendMessage(topic, { text: 'Offsets or pages?' });
  await settle(rt);
  assert.equal(store.state.threads[topic].unread, 1);
});

test('#1429 M settles an app-check turn’s app before N marks the agent idle', async () => {
  const { rt, store, beta } = setup();
  rt.toolsFor(beta.id).show_app({ id: 'lab', title: 'Lab', code: '<p>x</p>', permissions: [] });
  /** @type {string[]} */
  const order = [];
  store.subscribe((/** @type {any} */ ev) => {
    if (ev.type === 'app' && ev.data.check?.status !== 'fixing' && ev.data.check?.status) order.push('app settled');
    if (ev.type === 'session.patch' && ev.data.id === beta.id && ev.data.patch.state === 'idle') order.push('agent idle');
  });
  rt.appCheck('lab', { version: 1, problems: [{ code: 'overflow', message: 'The chart runs past the frame.' }] });
  await settle(rt);
  assert.deepEqual(order.slice(0, 2), ['app settled', 'agent idle']);
});

test('#733 an entry that came before what waited on the turn starts first', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha start' });
  await sleep(5);
  const from = f.adapter.calls.length;
  f.rt.sendMessage(f.t.id, { text: '@alpha queued one' });
  await sleep(2);
  // A message for the busy turn waits on it, as a resumed host turn’s or a Send now’s does (turn-run.mjs, waitsBehind).
  f.rt.turnService.run(f.alpha.id, { kind: 'user', text: 'waited on the turn' }, { threadId: f.t.id });
  assert.equal(f.rt.turns.get(f.alpha.id).pending.length, 1);
  busy.release();
  await settle(f.rt);
  await settle(f.rt);
  assert.deepEqual(
    f.adapter.calls.slice(from).map((c) => c.parts.map((/** @type {any} */ p) => p.text)),
    [['@alpha queued one'], ['waited on the turn']],
  );
});
