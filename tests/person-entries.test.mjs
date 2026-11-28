// The person’s message is an inbox entry when it’s sent (designs/rooms-at-scale.md, “What an entry is”; the owner’s
// choice of 15 November 2026, #1404): it’s posted at once, with one `person` entry per recipient pointing at it, and a
// busy agent’s entry waits in its inbox, not in the thread’s queue. So a message to an agent whose Stop is still exiting
// waits where its queue shows it (#1136), and a restart finds the item already posted (#1108).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../server/runtime.mjs';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const said = (store, threadId, text) => store.items(threadId).filter((i) => i.kind === 'user' && i.text === text);
const givenTo = (adapter, se, text) => adapter.calls.filter((c) => c.sessionId === se.id && c.parts.some((m) => m.text === text)).length;

test('the person’s message to a busy agent is posted when it’s sent, with a person entry waiting for it', async () => {
  const { rt, store, adapter, t, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  await sleep(5);
  rt.sendMessage(t.id, { text: '@beta next' });
  const [item] = said(store, t.id, '@beta next');
  assert.ok(item, 'posted at send');
  assert.deepEqual(item.to, ['beta']);
  assert.deepEqual(
    arrange.waitingEntries(rt, beta.id).map((e) => [e.source, e.itemId, e.from]),
    [['person', item.id, 'you']],
  );
  assert.deepEqual(store.state.threads[t.id].queue ?? [], [], 'nothing waits in the thread’s queue');
  busy.release();
  await settle(rt);
  assert.equal(givenTo(adapter, beta, '@beta next'), 1, 'its turn is given the message');
  assert.equal(said(store, t.id, '@beta next').length, 1, 'posted once');
  assert.deepEqual(arrange.waitingEntries(rt, beta.id), []);
});

test('#1136 a message to an agent whose Stop is still exiting waits in its inbox, and goes once the exit finishes', async () => {
  const { rt, store, adapter, t, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  await sleep(5);
  rt.stop(beta.id, { by: 'you' });
  assert.ok(arrange.exiting(rt, beta.id), 'the stopped turn is exiting');
  rt.sendMessage(t.id, { text: '@beta during the exit' });
  assert.equal(arrange.waitingEntries(rt, beta.id).length, 1, 'the queue’s badge counts it');
  assert.deepEqual(rt.running.exitOf(beta.id).held, [], 'nothing is held on the exiting turn');
  busy.release();
  await settle(rt);
  assert.equal(givenTo(adapter, beta, '@beta during the exit'), 1);
  assert.equal(said(store, t.id, '@beta during the exit').length, 1);
});

test('#1108 a message sent during a Stop’s exit at shutdown is in the transcript once after a restart, and given once', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  f.rt.stop(f.beta.id, { by: 'you' });
  f.rt.sendMessage(f.t.id, { text: '@beta held at shutdown' });
  const closing = f.rt.stopTurns({ graceMs: 200 });
  busy.release();
  await closing;
  const rt = new Runtime({ store: f.store, adapters: f.rt.adapters, config: f.rt.config });
  f.adapter.rt = rt;
  rt.drainAll();
  await settle(rt);
  assert.equal(said(f.store, f.t.id, '@beta held at shutdown').length, 1, 'one item in the transcript');
  assert.equal(givenTo(f.adapter, f.beta, '@beta held at shutdown'), 1, 'the agent is given it once');
});

/** @alpha and @beta both busy in turns held open until released. */
async function bothBusy() {
  const f = setup();
  const a = held();
  const b = held();
  f.adapter.next.push(a.step, b.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha @beta start' });
  await sleep(5);
  return { ...f, a, b };
}

test('Edit changes the person’s message while it waits for every agent, and is refused once one has it', async () => {
  const f = await bothBusy();
  const { item, queued } = f.rt.sendMessage(f.t.id, { text: '@alpha @beta next' });
  const forAlpha = queued.find((e) => e.sessionId === f.alpha.id);
  f.rt.editQueued(f.t.id, forAlpha.id, '@alpha @beta next, edited');
  assert.equal(f.store.item(f.t.id, item.id).text, '@alpha @beta next, edited', 'the item is the message, so it changes');
  f.a.release();
  await sleep(20);
  assert.equal(givenTo(f.adapter, f.alpha, '@alpha @beta next, edited'), 1, 'alpha reads it as edited');
  const forBeta = queued.find((e) => e.sessionId === f.beta.id);
  assert.throws(() => f.rt.editQueued(f.t.id, forBeta.id, 'too late'), { status: 409, message: /@alpha already has this message/ });
  assert.equal(f.store.item(f.t.id, item.id).text, '@alpha @beta next, edited');
  f.b.release();
  await settle(f.rt);
});

test('Remove stops one agent’s entry; the message says it was removed only once no agent has it or will', async () => {
  const f = await bothBusy();
  const { item, queued } = f.rt.sendMessage(f.t.id, { text: '@alpha @beta never mind' });
  const [forAlpha, forBeta] = [f.alpha, f.beta].map((se) => queued.find((e) => e.sessionId === se.id));
  f.rt.cancelQueued(f.t.id, forAlpha.id);
  assert.equal(f.store.item(f.t.id, item.id).removed, undefined, 'beta still waits for it');
  f.rt.cancelQueued(f.t.id, forBeta.id);
  assert.ok(f.store.item(f.t.id, item.id).removed?.at, 'no agent will read it now');
  f.a.release();
  f.b.release();
  await settle(f.rt);
  assert.equal(givenTo(f.adapter, f.alpha, '@alpha @beta never mind') + givenTo(f.adapter, f.beta, '@alpha @beta never mind'), 0);
  // What the room’s catch-up says of it, from then on: it was there, and it asks nothing.
  const line = f.rt.memory.describeItem(f.store.item(f.t.id, item.id), f.alpha);
  assert.match(line, /^The person, to @alpha, @beta: \(a message removed before any agent read it\)$/);
});

test('#1138 a send repeated with the same client id makes one item and one entry per agent, and is answered as sent', async () => {
  const { rt, store, adapter, t, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  await sleep(5);
  // The page’s outbox sends again when the response to its first try was lost.
  const first = rt.sendMessage(t.id, { text: '@beta once', clientId: 'cl_1' });
  const again = rt.sendMessage(t.id, { text: '@beta once', clientId: 'cl_1' });
  assert.equal(again.item.id, first.item.id, 'answered with the item the first try posted');
  assert.equal(said(store, t.id, '@beta once').length, 1);
  assert.equal(arrange.waitingEntries(rt, beta.id).length, 1);
  busy.release();
  await settle(rt);
  rt.sendMessage(t.id, { text: '@beta once', clientId: 'cl_1' });
  await settle(rt);
  assert.equal(said(store, t.id, '@beta once').length, 1, 'a try after it was delivered posts nothing either');
  assert.equal(givenTo(adapter, beta, '@beta once'), 1);
});
