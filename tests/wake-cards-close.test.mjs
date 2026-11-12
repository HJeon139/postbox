// #693: a card whose requester is gone can't keep holding the room's wakes. Archiving or removing the agent that asked
// closes its open card, as retiring forks does, and each agent with a wake held on it is told at its next turn. The
// startup sweep closes such cards left from before. Stop leaves the card: the person can still answer it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../server/runtime.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const card = (f, id) => f.store.item(f.t.id, id);
const toldOf = (f, se) => (f.store.state.sessions[se.id].context ?? []).join(' | ');

/** @alpha asks to add @gamma, and @beta's wake of @delta is held on that card. */
function heldOnAlphasCard() {
  const f = setup();
  f.rt.createPersona({ handle: 'delta' });
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'Check the numbers.' });
  const open = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.status === 'open');
  const r = f.rt.toolsFor(f.beta.id).wake_agent({ handle: 'delta', message: 'Draw the chart.' });
  assert.equal(r.held, true, 'beta’s wake is held on alpha’s card');
  return { ...f, open };
}

const restart = (f) => new Runtime({ store: f.store, adapters: f.rt.adapters, config: f.rt.config });

test('#693 a card whose agent is removed closes, and the agent whose wake was held on it is told', async () => {
  const f = heldOnAlphasCard();
  f.rt.deleteSession(f.alpha.id);
  await settle(f.rt);
  assert.equal(card(f, f.open.id).status, 'closed');
  assert.match(toldOf(f, f.beta), /Your message to @delta \(“Draw the chart.”\), held on @alpha’s request to add @gamma.*didn’t go: @alpha was removed/);
  const again = f.rt.toolsFor(f.beta.id).wake_agent({ handle: 'delta', message: 'Draw the chart.' });
  assert.deepEqual([again.waiting, again.held], [true, undefined], 'the next wake asks the person with a card of its own');
});

test('#693 Stop leaves the card open: the person can still answer it', async () => {
  const f = setup();
  const work = held();
  f.adapter.next.push(work.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha go on' });
  await sleep(5);
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'Check the numbers.' });
  const open = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.status === 'open');
  assert.equal(f.rt.stop(f.alpha.id), true, 'a turn was running, so Stop reached its wakes');
  work.release();
  await settle(f.rt);
  assert.equal(card(f, open.id).status, 'open');
});

test('#693 the startup sweep closes an open card whose agent is a retired fork, from a room before this fix', () => {
  const f = heldOnAlphasCard();
  f.store.emit('session', { ...f.store.state.sessions[f.alpha.id], retiredFork: true }); // as an older Postbox left it
  restart(f);
  assert.equal(card(f, f.open.id).status, 'closed');
  assert.match(toldOf(f, f.beta), /Your message to @delta .* didn’t go/);
});

test('#693 the startup sweep leaves a card whose agent is still here', () => {
  const f = heldOnAlphasCard();
  restart(f);
  assert.equal(card(f, f.open.id).status, 'open');
  assert.equal(card(f, f.open.id).held.length, 1);
});
