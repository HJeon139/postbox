// The ask checks (#508, server/room-checks-asks.mjs): a wake held on a card that went without an answer and never
// arrived, and a needs-you ring that disagrees with the open asks. Each fires on a room with its defect and stays
// silent on one without. The rooms are hand-built from the shapes UAT runs record (tests/delivery-fixture.mjs says
// why, and which). Moved from tests/uat-checks-delivery.test.mjs for size.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headOf } from '../server/room-delivery.mjs';
import { runChecks } from '../tools/uat/checks.mjs';
import { ROOM, ROUND_TWO, room, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;
const found = (f, id) => runChecks(f, { only: [id] });

/** A card from @researcher to @critic with @critic’s wake of @researcher held on it, retired when @critic was woken. */
function heldRoom({ arrives }) {
  const r = room();
  r.agent('researcher');
  r.agent('critic');
  r.add({
    id: 'it_card',
    at: s(1),
    kind: 'hop',
    from: 'researcher',
    fromSessionId: 'se_researcher',
    to: 'critic',
    text: '@critic please review',
    status: 'open',
  });
  r.patch('it_card', { held: [{ fromSessionId: 'se_critic', from: 'critic', to: 'researcher', text: ROUND_TWO, at: s(5) }] });
  r.patch('it_card', { status: 'retired', retiredAt: s(9) });
  r.add({ id: 'it_voice', at: s(9), kind: 'voice', text: 'You wrote to @critic' });
  r.turn('researcher', s(12), { prompt: arrives ? `[Postbox] @critic wrote to you.\n\n${ROUND_TWO}` : '[Postbox] You: what’s left?' });
  return r.f;
}

test('ask-dropped fires for a wake held on a card that was retired and never reached its agent', () => {
  const out = found(heldRoom({ arrives: false }), 'ask-dropped');
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /went on when the card was retired, and @researcher never got it/);
  assert.deepEqual(out[0].requirements, ['AT-1']);
  assert.equal(out[0].issue, 439);
});

test('ask-dropped stays silent when the held wake went on and arrived', () => {
  assert.deepEqual(found(heldRoom({ arrives: true }), 'ask-dropped'), []);
});

test('ask-dropped doesn’t judge a held wake while the turn due to carry it is still running', () => {
  for (const recorded of [true, false]) {
    const f = heldRoom({ arrives: false });
    const turn = /** @type {any} */ (f.streams.at(-1));
    turn.ended = turn.started + 5;
    Object.assign(f.state.sessions.se_researcher, { state: 'gen', finishedAt: null });
    if (!recorded) f.transcripts.find((t) => t.handle === 'researcher').lines.length = 0;
    assert.deepEqual(found(f, 'ask-dropped'), [], `transcript line: ${recorded}`);
  }
});

/**
 * A card from @critic to @developer with @researcher’s wake of @critic held on it, retired when @developer was woken
 * another way. Retiring sends each wake on (server/wake-cards.mjs’s retireStale): the card’s own raises the next
 * card, and the held one is held on that card. @critic takes a turn meanwhile that doesn’t carry it. Then the next
 * card is allowed, or retired in its turn, and the wake reaches @critic, or doesn’t.
 */
function movedRoom({ next = 'open', arrives = false } = {}) {
  const r = room();
  for (const h of ['researcher', 'critic', 'developer']) r.agent(h);
  const card = { kind: 'hop', from: 'critic', fromSessionId: 'se_critic', to: 'developer', text: '@developer which version: 2.0.0 or 2.0?' };
  const wake = { fromSessionId: 'se_researcher', from: 'researcher', to: 'critic', text: ROUND_TWO };
  r.add({ id: 'it_card', at: s(1), ...card, status: 'open' });
  r.patch('it_card', { held: [{ ...wake, at: s(3) }] });
  r.patch('it_card', { status: 'retired', retiredWhy: '@researcher woke it', retiredAt: s(9) });
  r.add({ id: 'it_next', at: s(9), ...card, status: 'open' });
  r.patch('it_next', { held: [{ ...wake, at: s(9) }] });
  r.add({ id: 'it_voice', at: s(10), kind: 'voice', text: 'Closed: @developer got a turn another way' });
  r.turn('critic', s(12), { prompt: '[Postbox] You: what’s left?' });
  if (next === 'allowed') {
    r.patch('it_next', { status: 'allowed' });
    r.add({ id: 'it_allowed', at: s(20), kind: 'voice', text: 'Allowed: @critic wakes @developer' });
  }
  if (next === 'retired') {
    r.patch('it_next', { status: 'retired', retiredWhy: 'you wrote to it', retiredAt: s(20) });
    r.add({ id: 'it_wrote', at: s(20), kind: 'user', text: '@developer go ahead' });
  }
  if (next !== 'open') r.turn('critic', s(21), { prompt: arrives ? `[Postbox] @researcher wrote to you.\n\n${ROUND_TWO}` : '[Postbox] You: anything else?' });
  return r.f;
}

test('ask-dropped follows a held wake its retired card moved to the next card, while that card waits', () => {
  assert.deepEqual(found(movedRoom(), 'ask-dropped'), []);
});

test('ask-dropped stays silent when the next card, holding the moved wake, is allowed and delivers it', () => {
  assert.deepEqual(found(movedRoom({ next: 'allowed', arrives: true }), 'ask-dropped'), []);
});

test('ask-dropped fires for a moved wake once the last card it was held on ends without delivering it', () => {
  const out = found(movedRoom({ next: 'retired' }), 'ask-dropped');
  assert.deepEqual(
    out.map((x) => x.key),
    [`ask-dropped:it_next:se_researcher:critic:${headOf(ROUND_TWO)}`],
  );
  assert.match(out[0].evidence, /moved from it_card/);
  assert.deepEqual(found(movedRoom({ next: 'retired', arrives: true }), 'ask-dropped'), []);
});

test('ask-dropped fires for a card that left the state with no answer', () => {
  const f = heldRoom({ arrives: true });
  f.state.items[ROOM] = f.state.items[ROOM].filter((it) => it.id !== 'it_card');
  f.events = f.events.filter((e) => e.data?.patch?.status !== 'retired');
  const out = found(f, 'ask-dropped');
  assert.deepEqual(
    out.map((x) => x.key),
    ['ask-dropped:it_card'],
  );
});

/** @critic’s open choice, with its session needing you for it, or for nothing. */
function needsRoom(needs) {
  const r = room();
  r.agent('critic');
  r.add({
    id: 'it_choice',
    at: s(1),
    kind: 'block',
    sessionId: 'se_critic',
    handle: 'critic',
    valid: true,
    answered: false,
    block: { id: 'fmt', type: 'choice', title: 'Storage format' },
  });
  r.f.state.sessions.se_critic.needs = needs;
  return r.f;
}

test('needs-mismatch fires for an open choice whose agent doesn’t need you', () => {
  // As the needsnav run of 24 October 2026 ended: @critic’s choice open, its session needing nothing.
  const out = found(needsRoom(null), 'needs-mismatch');
  assert.equal(out.length, 1);
  assert.match(out[0].title, /@critic has an open ask, and its ring doesn’t say it needs you/);
  assert.deepEqual(out[0].requirements, ['AT-4']);
});

test('needs-mismatch stays silent when the agent needs you for its open choice', () => {
  assert.deepEqual(found(needsRoom({ kind: 'block', itemId: 'it_choice', text: 'a choice' }), 'needs-mismatch'), []);
});

test('needs-mismatch fires for a ring left on a choice already answered', () => {
  const f = needsRoom({ kind: 'block', itemId: 'it_choice', text: 'a choice' });
  /** @type {any} */ (f.state.items[ROOM][0]).answered = true;
  assert.deepEqual(
    found(f, 'needs-mismatch').map((x) => x.key),
    ['needs-mismatch:se_critic:it_choice'],
  );
});
