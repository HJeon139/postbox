// #237: a card asking for a tool that’s turned off (#104) follows the persona’s Tools, wherever they’re changed. The
// agent panel’s switch changes the persona (PATCH /api/personas/:id, Runtime.updatePersona), as the card’s own button
// does, so an open card for that tool answers itself and the agent carries on.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ScriptedAdapter {
  name = 'mock';
  constructor() {
    this.calls = [];
    this.next = [];
  }
  async deliver(session, message, ctx) {
    this.calls.push({ sessionId: session.id, message });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx);
  }
}

function setup() {
  const store = new Store(null);
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'critic', tools: ['corpus.search'] });
  return { store, rt, adapter, a };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};
/** A conversation whose agent asked for shell and ended its turn, so the card is open and the agent needs you. */
async function asked(rt, adapter, a, title) {
  const t = rt.createThread({ projectId: 'p1', title, personaIds: [a.id] });
  adapter.next.push(async (c) => {
    c.tools.ask_for_tool({ tool: 'shell', why: 'To run the tests.' });
  });
  rt.sendMessage(t.id, { text: 'run the tests' });
  await settle(rt);
  return { t, se: rt.sessionsIn(t.id)[0] };
}
const voices = (store, t) =>
  store
    .items(t.id)
    .filter((i) => i.kind === 'voice')
    .map((i) => i.text);
const notices = (adapter, se) => adapter.calls.filter((c) => c.sessionId === se.id && c.message.kind === 'notice');

test('Shell turned on from the agent panel answers its open cards in every conversation, and each agent carries on', async () => {
  const { store, rt, adapter, a } = setup();
  const one = await asked(rt, adapter, a, 'One');
  const two = await asked(rt, adapter, a, 'Two');
  const card = (x) => store.items(x.t.id).find((i) => i.kind === 'toolask');
  assert.equal(store.state.sessions[one.se.id].needs?.kind, 'toolask');
  rt.updatePersona(a.id, { tools: ['corpus.search', 'shell'] });
  await settle(rt);
  for (const x of [one, two]) {
    assert.equal(card(x).status, 'on');
    assert.equal(store.state.sessions[x.se.id].needs, null, 'it no longer needs you');
    assert.deepEqual(voices(store, x.t), ['Turned on “Run commands in the project folder” for @critic']);
    assert.equal(notices(adapter, x.se).length, 1, 'the agent hears it once');
    assert.match(notices(adapter, x.se)[0].message.text, /turned on shell \(Run commands in the project folder\) for you/);
  }
  assert.throws(() => rt.act(one.t.id, card(one).id, 'on'), /already answered/);
});

test('the card’s own button still answers it once', async () => {
  const { store, rt, adapter, a } = setup();
  const one = await asked(rt, adapter, a, 'One');
  rt.act(one.t.id, store.items(one.t.id).find((i) => i.kind === 'toolask').id, 'on');
  await settle(rt);
  assert.deepEqual(store.state.personas[a.id].tools, ['corpus.search', 'shell']);
  assert.deepEqual(voices(store, one.t), ['Turned on “Run commands in the project folder” for @critic']);
  assert.equal(notices(adapter, one.se).length, 1);
});

test('a change that doesn’t turn the asked tool on leaves the card open', async () => {
  const { store, rt, adapter, a } = setup();
  const one = await asked(rt, adapter, a, 'One');
  rt.updatePersona(a.id, { tools: ['corpus.search', 'web.fetch'] });
  rt.updatePersona(a.id, { description: 'Reviews changes.' });
  await settle(rt);
  assert.equal(store.items(one.t.id).find((i) => i.kind === 'toolask').status, 'open');
  assert.equal(store.state.sessions[one.se.id].needs?.kind, 'toolask');
  assert.equal(notices(adapter, one.se).length, 0);
});

test('a card in a conversation you’re deleting is answered, but no turn starts there', async () => {
  const { store, rt, adapter, a } = setup();
  const one = await asked(rt, adapter, a, 'One');
  rt.deleteThread(one.t.id);
  rt.updatePersona(a.id, { tools: ['corpus.search', 'shell'] });
  await settle(rt);
  assert.equal(store.items(one.t.id).find((i) => i.kind === 'toolask').status, 'on');
  assert.equal(notices(adapter, one.se).length, 0, 'the agent isn’t woken there');
  assert.equal(rt.turns.size, 0);
});
