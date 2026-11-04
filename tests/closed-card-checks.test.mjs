// #693: a card closed with no answer from the person (its agent was archived, removed or retired) is settled, as a
// declined one is: every agent held on it was told, so the room check doesn't call its wakes dropped once it leaves
// the state.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { hopCards } from '../tools/uat/triggers-hostwakes.mjs';
import { ROUND_TWO, room, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;

function closedRoom(status) {
  const r = room();
  r.agent('researcher');
  r.agent('critic');
  r.add({ id: 'it_card', at: s(1), kind: 'hop', from: 'researcher', fromSessionId: 'se_researcher', to: 'critic', text: 'Wake?', status: 'open' });
  r.patch('it_card', { held: [{ fromSessionId: 'se_critic', from: 'critic', to: 'researcher', text: ROUND_TWO, at: s(5) }] });
  r.patch('it_card', { status, closedAt: s(9) });
  for (const t of r.f.threads) r.f.state.items[t] = (r.f.state.items[t] ?? []).filter((it) => it.id !== 'it_card');
  return r.f;
}

test('#693 ask-dropped counts a closed card as settled, as it does a declined one', () => {
  assert.deepEqual(runChecks(closedRoom('declined'), { only: ['ask-dropped'] }), [], 'declined, as before');
  assert.deepEqual(runChecks(closedRoom('closed'), { only: ['ask-dropped'] }), []);
});

test('#693 a closed card was answered, for the hostwakes checks, when it closed', () => {
  const card = { id: 'it_c', kind: 'hop', from: 'alpha', to: 'gamma', join: true, text: 'Add?', at: s(1), status: 'closed', closedAt: s(9) };
  const f = { threads: ['th'], state: { items: { th: [card] } } };
  assert.equal(hopCards(f)[0].answeredAt, s(9));
});
