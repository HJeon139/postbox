// The delivery scenario’s triggers (#508, tools/uat/delivery-triggers.mjs): each fires on a room where Postbox showed
// what it names, and stays silent on one where it didn’t. The rooms are hand-built from the shapes UAT runs record
// (tests/delivery-fixture.mjs says why, and which).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phaseGoals, TRIGGERS } from '../tools/uat/triggers.mjs';
import { DRAFT, ROOM, ROUND_TWO, room, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;
const fires = (id, f) => TRIGGERS[id].run(f);

/** A card from @critic to @developer, with a held wake from a pair that’s the same, or another. */
function cardRoom({ heldFrom = 'researcher', heldTo = 'critic', allowed = false, arrives = true } = {}) {
  const r = room();
  for (const h of ['researcher', 'critic', 'developer']) r.agent(h);
  r.add({
    id: 'it_card',
    at: s(1),
    kind: 'hop',
    from: 'critic',
    fromSessionId: 'se_critic',
    to: 'developer',
    text: '@developer which version: 2.0.0 or 2.0?',
    status: 'open',
  });
  r.patch('it_card', { held: [{ fromSessionId: `se_${heldFrom}`, from: heldFrom, to: heldTo, text: ROUND_TWO, at: s(3) }] });
  if (allowed) {
    r.patch('it_card', { status: 'allowed' });
    r.add({ id: 'it_voice', at: s(9), kind: 'voice', text: 'Allowed: @critic wakes @developer' });
    r.turn('developer', s(10), { prompt: '[Postbox] @critic wrote to you.\n\n@developer which version: 2.0.0 or 2.0?' });
    r.turn(heldTo, s(10), { prompt: arrives ? `[Postbox] @${heldFrom} wrote to you.\n\n${ROUND_TWO}` : '[Postbox] You: Allowed.' });
  }
  return r.f;
}

test('held-behind-card fires when a second pair’s wake is held on an open card', () => {
  const out = fires('held-behind-card', cardRoom());
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /held @researcher’s wake of @critic too/);
});

test('held-behind-card stays silent when only the card’s own pair waits on it', () => {
  assert.deepEqual(fires('held-behind-card', cardRoom({ heldFrom: 'developer', heldTo: 'critic' })), []);
});

test('held-released fires when Allow delivered the card’s wake and every one held on it', () => {
  assert.equal(fires('held-released', cardRoom({ allowed: true })).length, 1);
});

test('held-released stays silent when a held wake didn’t arrive', () => {
  assert.deepEqual(fires('held-released', cardRoom({ allowed: true, arrives: false })), []);
});

/** @researcher mentioned, then `after` items from others, then its turn, whose prompt holds the mention or doesn’t. */
function capRoom(after, { delivered = true } = {}) {
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_oldest', at: s(1), kind: 'user', text: DRAFT });
  for (let i = 0; i < after; i++)
    r.add({ id: `it_${i}`, at: s(2 + i), kind: 'agent', handle: 'critic', text: `Release note ${i}: nothing for @researcher here.` });
  r.turn('researcher', s(100), { prompt: delivered ? `[Postbox] Mentions of you first:\n\nYou: ${DRAFT}` : '[Postbox] The last 40 items.' });
  return r.f;
}

test('mention-past-cap fires when a mention older than the catch-up’s 40 items reached its agent', () => {
  const out = fires('mention-past-cap', capRoom(41));
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /it_oldest, with 41 items after it/);
});

test('mention-past-cap stays silent within the cap, or when the mention didn’t arrive', () => {
  assert.deepEqual(fires('mention-past-cap', capRoom(39)), []);
  assert.deepEqual(fires('mention-past-cap', capRoom(41, { delivered: false })), []);
});

/** The person’s mention of @critic, edited while @critic worked; its next turn gets the new text once, or twice. */
function editRoom({ twice = false } = {}) {
  const r = room();
  r.agent('critic');
  r.turn('critic', s(1), { prompt: 'A long job.', ms: 30_000 });
  r.add({ id: 'it_ask', at: s(5), kind: 'user', text: '@critic check the changelog wording for the 2.0 release' });
  const edited = '@critic check the changelog wording and the version number for the 2.0 release';
  r.patch('it_ask', { text: edited });
  r.add({ id: 'it_next', at: s(8), kind: 'voice', text: 'later' });
  r.turn('critic', s(40), { prompt: edited });
  if (twice) r.turn('critic', s(60), { prompt: edited });
  return r.f;
}

test('edit-while-waiting fires when an edit made while the message waited arrived once', () => {
  assert.equal(fires('edit-while-waiting', editRoom()).length, 1);
});

test('edit-while-waiting stays silent when the edited message arrived twice', () => {
  assert.deepEqual(fires('edit-while-waiting', editRoom({ twice: true })), []);
});

test('edit-while-waiting stays silent when only the old revision arrived, the edit past the first 60 letters', () => {
  // gpt’s regression (#523 review): the change comes after a long shared start, and the prompt carries the old text.
  const r = room();
  r.agent('critic');
  const prefix = '@critic Please review the proposed release checklist and the changelog wording carefully before publishing. ';
  const old = `${prefix}Use version 1.0.`;
  r.add({ id: 'it_edit', at: s(1), kind: 'user', text: old });
  r.patch('it_edit', { text: `${prefix}Use version 2.0.` });
  r.add({ id: 'it_time', at: s(2), kind: 'voice', text: 'Edited message' });
  r.turn('critic', s(3), { prompt: old });
  assert.deepEqual(fires('edit-while-waiting', r.f), [], 'the agent never received version 2.0');
});

test('edit-while-waiting counts only prompts after the edit', () => {
  // The new text in a prompt from before the edit can’t be the edit arriving: it was some other message.
  const r = room();
  r.agent('critic');
  const edited = '@critic check the changelog wording and the version number for the 2.0 release';
  r.turn('critic', s(1), { prompt: edited });
  r.add({ id: 'it_ask', at: s(10), kind: 'user', text: '@critic check the changelog wording for the 2.0 release' });
  r.patch('it_ask', { text: edited });
  r.add({ id: 'it_next', at: s(12), kind: 'voice', text: 'later' });
  r.turn('critic', s(40), { prompt: edited });
  assert.equal(fires('edit-while-waiting', r.f).length, 1);
});

/** @researcher asked; its first turn writes nothing, and the next carries the request, or doesn’t. */
function failRoom({ carried = true, output = false } = {}) {
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_ask', at: s(1), kind: 'user', text: DRAFT });
  r.turn('researcher', s(2), { output, ms: 500 });
  r.turn('researcher', s(10), { prompt: carried ? `[Postbox] Your last turn failed before any output; resent.\n\n${DRAFT}` : 'Something else.' });
  return r.f;
}

test('fail-before-output fires when a turn wrote nothing and the next turn carried its message', () => {
  const out = fires('fail-before-output', failRoom());
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /wrote nothing, and its next turn carried/);
});

test('fail-before-output stays silent when no turn failed, or the next turn didn’t carry it', () => {
  assert.deepEqual(fires('fail-before-output', failRoom({ output: true })), []);
  assert.deepEqual(fires('fail-before-output', failRoom({ carried: false })), []);
});

/** The person’s request given whole twice: the second labeled as a resend, as a pointer, or bare. */
function resendRoom(second) {
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_ask', at: s(1), kind: 'user', text: DRAFT });
  r.turn('researcher', s(2), { prompt: DRAFT });
  r.turn('researcher', s(10), { prompt: second });
  return r.f;
}

test('resend-labeled fires when a message came whole again under a resend label', () => {
  assert.equal(fires('resend-labeled', resendRoom(`[Postbox] Resent: your last turn failed before any output.\n\n${DRAFT}`)).length, 1);
});

test('resend-labeled stays silent on a bare repeat and on a pointer to a message already given', () => {
  assert.deepEqual(fires('resend-labeled', resendRoom(`You: ${DRAFT}`)), []);
  assert.deepEqual(fires('resend-labeled', resendRoom(`The person’s message above, which your last summary gave you in full: “${DRAFT}”`)), []);
});

test('each delivery trigger carries its requirements, and a phase’s coverage reports them', () => {
  const want = {
    'held-behind-card': ['AT-1'],
    'held-released': ['AT-1', 'AT-2'],
    'mention-past-cap': ['DL-1', 'DL-5'],
    'edit-while-waiting': ['DL-7'],
    'fail-before-output': ['DL-3'],
    'resend-labeled': ['DL-2', 'DL-3'],
  };
  for (const [id, reqs] of Object.entries(want)) assert.deepEqual(TRIGGERS[id]?.requirements, reqs, id);
  const goals = phaseGoals({ phases: [{ title: 'Phase 1', triggers: ['held-behind-card'], steps: 8 }] }, { cap: (p) => p.steps });
  assert.deepEqual(goals.coverage()[0].requirements, ['AT-1']);
});

test('the delivery triggers read the room each fixture builds', () => {
  // Guards the fixture itself: a trigger that can’t read its facts would stay silent everywhere.
  const f = cardRoom();
  assert.equal(f.state.items[ROOM].length, 1);
  for (const id of ['held-behind-card', 'held-released', 'mention-past-cap', 'edit-while-waiting', 'fail-before-output', 'resend-labeled'])
    assert.equal(TRIGGERS[id].recorded(f), true, id);
});
