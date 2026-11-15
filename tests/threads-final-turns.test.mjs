// Every path by which a turn settles its reply raises item.final once per segment (designs/architecture/services.md,
// “Delivery and Turns, built as the inbox”, step 1): a segment that closes mid-turn, the end of a turn that went well,
// a failed one and a stopped one. A reply is never final while it streams, so a mention in it can’t be handed over cut
// short (#834). Through a runtime with a scripted agent, arranged and heard through tests/arrange.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

/** A runtime whose one agent runs each step it’s given, and a record of every item.final it raises. */
function setup() {
  const store = new Store(null);
  const adapter = {
    name: 'mock',
    /** @type {((c: any) => Promise<void>)[]} */
    next: [],
    async deliver(_se, _m, ctx) {
      await (this.next.shift() ?? (async (c) => c.text('ok')))(ctx);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/proj' });
  const a = rt.createPersona({ handle: 'dev' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const se = arrange.agentIn(rt, t.id, 'dev');
  /** @type {any[]} each final item, as it was when it became final */
  const finals = [];
  arrange.onItemFinal(rt, ({ threadId, item }) => finals.push({ threadId, id: item.id, kind: item.kind, text: item.text, status: item.status }));
  return { rt, store, adapter, t, se, finals };
}

const settle = async (rt) => {
  for (let i = 0; i < 200 && arrange.liveTurns(rt); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(arrange.liveTurns(rt), 0, 'the turn ended');
};
const replies = (finals) => finals.filter((f) => f.kind === 'agent');

test('a reply isn’t final while it streams, and is final once, whole, when its turn ends', async () => {
  const { rt, adapter, se, finals } = setup();
  /** @type {any[]} */
  let midTurn = [];
  adapter.next.push(async (c) => {
    c.text('I think ');
    c.text('@beta should look');
    midTurn = replies(finals);
  });
  await rt.deliver(se.id, { text: 'hi' });
  await settle(rt);
  assert.deepEqual(midTurn, [], 'nothing is final while the reply streams');
  const done = replies(finals);
  assert.equal(done.length, 1);
  assert.equal(done[0].text, 'I think @beta should look');
  assert.equal(done[0].status, 'done');
});

test('a segment closed mid-turn is final once, when it closes, and the next one when the turn ends', async () => {
  const { rt, store, adapter, t, se, finals } = setup();
  /** @type {any[]} */
  let atClose = [];
  adapter.next.push(async (c) => {
    c.text('First part, @beta');
    c.activity({ id: 'st_1', label: 'Read', state: 'done' });
    // Something posted below the reply, then more words after a step: they start a new part, and the first closes.
    arrange.post(rt, t.id, { kind: 'user', text: 'Meanwhile' });
    c.text('Second part');
    atClose = replies(finals);
  });
  await rt.deliver(se.id, { text: 'hi' });
  await settle(rt);
  const parts = store.items(t.id).filter((x) => x.kind === 'agent');
  assert.equal(parts.length, 2, 'the reply was in two parts');
  assert.deepEqual(
    atClose.map((f) => [f.id, f.text]),
    [[parts[0].id, 'First part, @beta']],
    'the first part is final as it closes, while the turn still runs',
  );
  assert.deepEqual(
    replies(finals).map((f) => f.id),
    [parts[0].id, parts[1].id],
    'each part is final once',
  );
});

test('a failed reply is final once, with the words it had', async () => {
  const { rt, adapter, se, finals } = setup();
  adapter.next.push(async (c) => {
    c.text('Partly done, @beta');
    throw new Error('The backend went away.');
  });
  await rt.deliver(se.id, { text: 'hi' });
  await settle(rt);
  assert.deepEqual(
    replies(finals).map((f) => [f.text, f.status]),
    [['Partly done, @beta', 'failed']],
  );
});

test('a failed turn with no words is final once, as the failed reply it adds', async () => {
  const { rt, adapter, se, finals } = setup();
  adapter.next.push(async () => {
    throw new Error('The backend went away.');
  });
  await rt.deliver(se.id, { text: 'hi' });
  await settle(rt);
  assert.deepEqual(
    replies(finals).map((f) => f.status),
    ['failed'],
  );
});

test('a stopped reply is final once, when Stop settles it', async () => {
  const { rt, adapter, se, finals } = setup();
  /** @type {() => void} */
  let streamed = () => {};
  const started = new Promise((r) => {
    streamed = () => r(undefined);
  });
  adapter.next.push(async (c) => {
    c.text('Halfway, @beta');
    streamed();
    await new Promise((r) => c.signal.addEventListener('abort', r, { once: true }));
  });
  await rt.deliver(se.id, { text: 'hi' });
  await started;
  assert.deepEqual(replies(finals), [], 'nothing is final while the reply streams');
  await arrange.stopTurn(rt, se.id);
  await settle(rt);
  assert.deepEqual(
    replies(finals).map((f) => [f.text, f.status]),
    [['Halfway, @beta', 'stopped']],
  );
});

test('the person’s message a turn is given is final once, when it’s added', () => {
  const { rt, t, finals } = setup();
  const it = arrange.post(rt, t.id, { kind: 'user', text: 'Hi @dev', to: ['dev'] });
  assert.deepEqual(
    finals.map((f) => f.id),
    [it.id],
  );
});
