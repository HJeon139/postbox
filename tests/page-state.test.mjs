// /api/state carries each agent’s inbox only as far as the page can act on it (server/page-state.mjs): entries waiting,
// taken by a turn, failed or stopped. Delivered ones stay in the state and the log, so the answer doesn’t grow with a
// room’s history, as #1155 holds it for items.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageState } from '../server/page-state.mjs';
import { apply, emptyState } from '../shared/state.mjs';

/** /api/state’s answer for a state, through a store and runtime that hold only what pageState reads. */
function answerFor(state, turns = /** @type {any[]} */ ([])) {
  const store = { epoch: 'ep', status: {}, state };
  const rt = { localBackends: () => [], config: {}, store, running: { all: () => turns } };
  const adapters = { names: () => [], get: () => ({}), runsHere: () => true };
  return pageState(/** @type {any} */ ({ store, rt, adapters, origin: '', demo: false, real: null, config: {}, headers: { all: () => ({}) } }));
}

/** A state with one session whose inbox holds one entry in each open state, then `delivered` delivered ones. */
function stateWith(delivered) {
  const state = emptyState();
  apply(state, 'session', { id: 'se_b', threadId: 'th_c', handle: 'beta' });
  const add = (id, st) => apply(state, 'entry.add', { sessionId: 'se_b', entry: { id, threadId: 'th_c', source: 'mention', itemId: `it_${id}`, state: st } });
  for (const st of ['waiting', 'taken', 'failed', 'stopped']) add(`en_${st}`, st);
  for (let i = 0; i < delivered; i++) add(`en_d${i}`, 'delivered');
  return state;
}

test('/api/state gives the page the entries it can act on, and its size doesn’t grow with the delivered ones', () => {
  const none = answerFor(stateWith(0));
  const many = answerFor(stateWith(10_000));
  assert.deepEqual(
    many.state.inbox.se_b.map((e) => e.state),
    ['waiting', 'taken', 'failed', 'stopped'],
  );
  assert.equal(JSON.stringify(many).length, JSON.stringify(none).length);
});

test('/api/state carries the running turns’ live state, as the page may see it, and none when nothing runs', () => {
  assert.deepEqual(answerFor(emptyState()).live, []);
  const turn = {
    id: 'tu_1',
    sessionId: 'se_1',
    threadId: 'th_1',
    first: 'it_1',
    live: {
      changed: new Map([['s1', { itemId: 'it_1', step: { id: 's1', label: 'Read', state: 'running', secret: 'held' } }]]),
      rev: new Map([['s1', 1]]),
      session: { currentStep: 'Read', secret: 'held' },
    },
  };
  const [snap] = answerFor(emptyState(), [turn]).live;
  assert.deepEqual(snap, {
    kind: 'snapshot',
    turnId: 'tu_1',
    sessionId: 'se_1',
    threadId: 'th_1',
    itemId: 'it_1',
    session: { currentStep: 'Read' },
    steps: [{ id: 's1', label: 'Read', state: 'running' }],
  });
});
