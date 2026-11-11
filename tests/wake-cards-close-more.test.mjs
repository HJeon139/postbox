// #693, from the pre-review packet at c577d51e: the startup sweep runs after idle archives are restored; a close tells
// the agent that asked, and agents held on it even while archived or being removed, so a Restore or Undo finds the note;
// a closed card counts as settled; and the requester's need goes with the card.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../server/runtime.mjs';
import { setup } from './side-threads-fixture.mjs';

const card = (f, id) => f.store.item(f.t.id, id);
const toldOf = (f, se) => (f.store.state.sessions[se.id]?.context ?? []).join(' | ');
const restart = (f) => new Runtime({ store: f.store, adapters: f.rt.adapters, config: f.rt.config });

/** @alpha asks to add @gamma, and @beta's wake of @delta is held on that card. */
function heldOnAlphasCard() {
  const f = setup();
  f.rt.createPersona({ handle: 'delta' });
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'Check the numbers.' });
  const open = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.status === 'open');
  f.rt.toolsFor(f.beta.id).wake_agent({ handle: 'delta', message: 'Draw the chart.' });
  return { ...f, open };
}

test('#693 B1: an agent archived by idle archiving, restored at startup, keeps its card open', () => {
  const f = heldOnAlphasCard();
  f.store.emit('session', { ...f.store.state.sessions[f.alpha.id], archived: true });
  f.store.emit('settings', { archivesRestored: false }); // a store from before #320's restore
  restart(f);
  assert.equal(f.store.state.sessions[f.alpha.id].archived, false, 'restored');
  assert.equal(card(f, f.open.id).status, 'open', 'its card is still the person’s to answer');
});

test('#693 B2: an agent held on the card is told even while archived, so it reads the note once restored', () => {
  const f = heldOnAlphasCard();
  f.rt.archive(f.beta.id);
  f.rt.archive(f.alpha.id);
  assert.equal(card(f, f.open.id).status, 'closed');
  f.rt.restore(f.beta.id);
  assert.match(toldOf(f, f.beta), /Your message to @delta .* didn’t go: @alpha was archived/);
});

test('#693 the requester’s need goes with its closed card', () => {
  const f = heldOnAlphasCard();
  assert.equal(f.store.state.sessions[f.alpha.id].needs?.itemId, f.open.id);
  f.store.emit('session', { ...f.store.state.sessions[f.alpha.id], deleting: Date.now() + 60_000 });
  restart(f);
  assert.equal(f.store.state.sessions[f.alpha.id].needs, null);
});

test('#693 the sweep closes a card whose agent’s session is gone altogether', () => {
  const f = heldOnAlphasCard();
  f.rt.patchItem(f.t.id, f.open.id, { fromSessionId: 'se_purged' });
  restart(f);
  assert.equal(card(f, f.open.id).status, 'closed');
});

test('#693 the sweep’s note says the agent was archived or removed, not that it left a conversation it’s still in', () => {
  const f = heldOnAlphasCard();
  f.store.emit('session', { ...f.store.state.sessions[f.alpha.id], deleting: Date.now() + 60_000 });
  restart(f);
  assert.match(toldOf(f, f.beta), /didn’t go: @alpha was archived or removed/);
});

test('#693 answering a closed card says why it closed, not that it was answered', () => {
  const f = heldOnAlphasCard();
  f.rt.archive(f.alpha.id);
  assert.throws(() => f.rt.resolveHop(f.t.id, f.open.id, true), { status: 409, message: 'That request was closed: @alpha was archived.' });
});
