// #693: a card closed with no answer from the person (its agent was removed or retired) is settled, as a
// declined one is: every agent held on it was told, so the room check doesn't call its wakes dropped once it leaves
// the state.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { addressed, timeAfter } from '../tools/uat/room-delivery.mjs';
import { blockHistory } from '../tools/uat/room-history.mjs';
import { hopCards } from '../tools/uat/triggers-hostwakes.mjs';
import { jobTimeline } from '../tools/uat/triggers-jobs.mjs';
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

test('#693 a message held on a closed card stopped waiting when the card closed, read from the state', () => {
  const r = room();
  r.agent('researcher');
  r.agent('critic');
  r.add({ id: 'it_m', at: s(1), kind: 'agent', handle: 'researcher', sessionId: 'se_researcher', text: '@critic round two', status: 'done' });
  r.add({
    id: 'it_c',
    at: s(1),
    kind: 'hop',
    from: 'researcher',
    fromSessionId: 'se_researcher',
    to: 'gamma',
    join: true,
    status: 'closed',
    closedAt: s(9),
    held: [{ fromSessionId: 'se_researcher', from: 'researcher', to: 'critic', text: '@critic round two', itemId: 'it_m', at: s(2) }],
  });
  r.f.events = [];
  const due = addressed(r.f).find((a) => a.to === 'critic' && a.itemId === 'it_m');
  assert.equal(due?.due, s(9));
});

test('the time after a card’s patch is the next item added after it, across a restart’s new epoch too', () => {
  // As tools/uat/history.mjs keeps events after Postbox restarted: epoch 1, numbered from 1 again (#1529).
  const add = (seq, at, epoch) => ({ seq, ...(epoch ? { epoch } : {}), type: 'item.add', data: { threadId: 't1', item: { id: `i${seq}`, kind: 'user', at } } });
  const patch = { seq: 50, type: 'item.patch', data: { threadId: 't1', id: 'c1', patch: { status: 'declined' } } };
  const events = [add(40, 1_000), patch, add(3, 3_000, 1), add(60, 9_000, 1)];
  assert.equal(timeAfter(events, patch), 3_000);
  assert.equal(timeAfter([add(40, 1_000), patch, add(51, 2_000)], patch), 2_000);
});

test('a block answered before a restart and reopened after a turn in the new epoch was read, not reopened unread', () => {
  // As tools/uat/history.mjs keeps events after Postbox restarted: epoch 1, numbered from 1 again (#1529). The agent’s
  // turn starts after the answer, though its bare seq is lower.
  const block = {
    seq: 10,
    type: 'item.add',
    data: { threadId: 't1', item: { id: 'b1', kind: 'block', valid: true, sessionId: 'se_a', handle: 'a', revision: 1, block: { id: 'q' } } },
  };
  const answer = { seq: 50, type: 'item.patch', data: { threadId: 't1', id: 'b1', patch: { answered: true, answer: { at: 1_000, action: 'submit' } } } };
  const turn = { seq: 3, epoch: 1, type: 'session', data: { id: 'se_a', state: 'think', finishedAt: null } };
  const reopen = { seq: 9, epoch: 1, type: 'item.patch', data: { threadId: 't1', id: 'b1', patch: { answered: false, revision: 2, updatedAt: 5_000 } } };
  assert.deepEqual(blockHistory([block, answer, turn, reopen]).reopened, []);
  // Without the turn, the same reopen is unread.
  assert.equal(blockHistory([block, answer, reopen]).reopened.length, 1);
});

test('a job Stop asked about before a restart and kept after a Stop in the new epoch was kept from that Stop', () => {
  // As tools/uat/history.mjs keeps events after Postbox restarted: epoch 1, numbered from 1 again (#1529).
  const job = (state, kept = false) => [{ id: 'j1', state, ...(kept ? { kept: true } : {}) }];
  const events = [
    { seq: 50, type: 'session', data: { id: 'se_a', state: 'tool', stopAsk: true, jobs: job('running') } },
    { seq: 5, epoch: 1, type: 'session', data: { id: 'se_a', state: 'stopping', stopAsk: false, updatedAt: 9_000, jobs: job('running') } },
    { seq: 6, epoch: 1, type: 'session', data: { id: 'se_a', state: 'idle', jobs: job('running', true) } },
  ];
  const [r] = jobTimeline(events);
  assert.equal(r.keptAt, 6);
  assert.equal(r.afterStop, true);
  assert.equal(r.stopAt, 9_000);
});
