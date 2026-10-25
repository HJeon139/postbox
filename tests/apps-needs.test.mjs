// An app’s waiting card makes its agent need you until you answer it (#38), whatever turns the agent takes meanwhile:
// a turn that ends after the card came, and one the app’s own send starts, which counts as you moving on (#69).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

/** An adapter whose turns wait until the test lets each one end. */
class HeldAdapter {
  name = 'mock';
  calls = [];
  /** @type {(() => void)[]} */
  waiting = [];
  async folderFor() {
    return null;
  }
  async deliver(_session, message, ctx) {
    this.calls.push(message);
    await new Promise((r) => this.waiting.push(() => r(undefined)));
    ctx.text('ok');
  }
}

function withApp() {
  const store = new Store(null);
  const adapter = new HeldAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'alpha' }).id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.toolsFor(se.id).show_app({ id: 'spam', title: 'Spam', code: '<p>x</p>', permissions: [] });
  return { store, rt, adapter, t, se };
}
/** Lets every turn waiting in the adapter end, until none is left running. */
async function endTurns(rt, adapter) {
  for (let i = 0; i < 50 && (rt.turns.size || adapter.waiting.length); i++) {
    for (const end of adapter.waiting.splice(0)) end();
    await ticks(1);
  }
}
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const card = (store, t) => store.items(t.id).find((x) => x.kind === 'appsend');

test('#38 a turn that ends after an app’s card came leaves the agent needing you, on the card', async () => {
  const { rt, store, adapter, t, se } = withApp();
  // A send that goes through starts a turn for its event; the next is held on a card while that turn runs.
  rt.appEvent('spam', 'ok', { summary: 'First' }, { now: 1 });
  assert.equal(rt.turns.size, 1);
  rt.appEvent('spam', 'ok', { summary: 'Held' }, { hold: true, now: 2 });
  assert.equal(store.state.sessions[se.id].needs?.kind, 'appsend');
  await endTurns(rt, adapter);
  assert.deepEqual(store.state.sessions[se.id].needs, { kind: 'appsend', itemId: card(store, t).id, text: 'Spam wants to send 1 message for you' });
  assert.equal(store.state.sessions[se.id].state, 'needs');
});

test('#38 a turn for the app’s earlier send, starting after its card came, leaves the agent needing you, on the card', async () => {
  const { rt, store, adapter, t, se } = withApp();
  // Two sends go through: the first one’s turn runs, and the second one’s waits behind it. Then one is held.
  rt.appEvent('spam', 'ok', { summary: 'First' }, { now: 1 });
  rt.appEvent('spam', 'ok', { summary: 'Second' }, { now: 2 });
  rt.appEvent('spam', 'ok', { summary: 'Held' }, { hold: true, now: 3 });
  await ticks(10);
  assert.equal(adapter.calls.length, 1, 'the second send’s turn waits');
  // The first turn ends, and the second starts: an event of yours, so it moves on (#69). The card still waits.
  for (const end of adapter.waiting.splice(0)) end();
  await ticks(10);
  assert.equal(adapter.calls.length, 2);
  assert.equal(store.state.sessions[se.id].needs?.kind, 'appsend', 'needs you while that turn runs');
  await endTurns(rt, adapter);
  assert.equal(store.state.sessions[se.id].needs?.itemId, card(store, t).id, 'and after it ends');
  // Answering the card is what clears it.
  rt.act(t.id, card(store, t).id, 'deny');
  await endTurns(rt, adapter);
  assert.equal(store.state.sessions[se.id].needs, null);
});
