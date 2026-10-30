// The delivery checks (#508, designs/508/testing-strategy.md, “Triggers, checks and seeds to add”): each fires on a
// room with its defect and stays silent on one without, read from what `main` records. The rooms are hand-built from
// the shapes UAT runs record (tests/delivery-fixture.mjs says why, and which).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKS, runChecks } from '../tools/uat/checks.mjs';
import { ROUND_TWO, room, SUMMARY, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;
const found = (f, id) => runChecks(f, { only: [id] });

/** @critic mentions @researcher; @researcher then takes two turns, whose prompts hold the mention or don’t. */
function mentionRoom({ delivered }) {
  const r = room();
  r.agent('researcher');
  r.agent('critic');
  r.add({ id: 'it_round2', at: s(10), kind: 'agent', handle: 'critic', sessionId: 'se_critic', text: ROUND_TWO });
  r.turn('researcher', s(20), {
    prompt: delivered
      ? `[Postbox] What happened in this room since your last turn:\n\n@critic: ${ROUND_TWO}`
      : '[Postbox] You: Allowed: @critic wakes @researcher',
  });
  r.turn('researcher', s(40), { prompt: '[Postbox] What happened in this room since your last turn:\n\nYou: are we done?' });
  return r.f;
}

test('delivery-dropped fires for a mention in none of its agent’s prompts by the end of its next two turns', () => {
  const out = found(mentionRoom({ delivered: false }), 'delivery-dropped');
  assert.equal(out.length, 1);
  assert.match(out[0].title, /addressed to @researcher never reached it/);
  assert.match(out[0].evidence, /it_round2/);
  assert.deepEqual(out[0].requirements, ['DL-1', 'SW-2']);
  assert.equal(out[0].issue, 484);
});

test('delivery-dropped stays silent when a catch-up line carried the mention', () => {
  assert.deepEqual(found(mentionRoom({ delivered: true }), 'delivery-dropped'), []);
});

test('delivery-dropped tells apart two mentions of one agent that begin alike, and catches the second dropped', () => {
  // Two rounds of a review, each opening with the same sentence: well past the first 60 letters and digits.
  const opening = '@researcher Round review of the release checklist from critic, items one through fourteen, follows here. ';
  const r = room();
  r.agent('researcher');
  r.agent('critic');
  r.add({ id: 'it_first', at: s(10), kind: 'agent', handle: 'critic', sessionId: 'se_critic', text: `${opening}I accept items 7 and 12a.` });
  r.add({ id: 'it_second', at: s(15), kind: 'agent', handle: 'critic', sessionId: 'se_critic', text: `${opening}Now fix items 12b and 14.` });
  r.turn('researcher', s(20), { prompt: `[Postbox] What happened in this room since your last turn:\n\n@critic: ${opening}I accept items 7 and 12a.` });
  r.turn('researcher', s(40), { prompt: '[Postbox] What happened in this room since your last turn:\n\nYou: are we done?' });
  assert.deepEqual(
    found(r.f, 'delivery-dropped').map((x) => x.key),
    ['delivery-dropped:researcher:it_second'],
  );
});

test('delivery-dropped waits for two turns before it calls a mention dropped', () => {
  const f = mentionRoom({ delivered: false });
  f.streams.pop();
  assert.deepEqual(found(f, 'delivery-dropped'), []);
});

/** @developer’s answer to @critic, which Postbox held on @critic’s open card waking @developer. */
const REPLY =
  'I can’t settle the version number yet, because I don’t have one to propose. @critic, send me the version you want and the file it should live in.';

/**
 * @critic’s card to wake @developer waits on the person; @developer’s reply mentioning @critic is held on it, and @critic
 * takes two turns while it waits. Postbox recorded this in the delivery run of 29 October 2026.
 */
function heldOnOpenCard() {
  const r = room();
  r.agent('developer');
  r.agent('critic');
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
  r.add({ id: 'it_reply', at: s(5), kind: 'agent', handle: 'developer', sessionId: 'se_developer', text: REPLY });
  r.patch('it_card', { held: [{ fromSessionId: 'se_developer', from: 'developer', to: 'critic', text: REPLY, itemId: 'it_reply', at: s(5) }] });
  r.turn('critic', s(10), { prompt: '[Postbox] What happened in this room since your last turn:\n\nYou: how is the changelog?' });
  r.turn('critic', s(30), { prompt: '[Postbox] Nothing new in this room since your last turn.' });
  return r;
}

/** The person allows the card, and @critic’s next two turns hold the held reply, or don’t. */
function allowHeld(r, { delivered }) {
  r.patch('it_card', { status: 'allowed' });
  r.add({ id: 'it_allowed', at: s(50), kind: 'voice', text: 'Allowed: @critic wakes @developer' });
  r.turn('critic', s(51), {
    prompt: delivered ? `[Postbox] @developer’s message, held until now:\n\n${REPLY}` : '[Postbox] You: Allowed: @critic wakes @developer',
  });
  r.turn('critic', s(70), { prompt: '[Postbox] Nothing new in this room since your last turn.' });
}

test('delivery-dropped doesn’t count a mention held on an open card as due, mid-run or once it’s allowed and delivered', () => {
  const r = heldOnOpenCard();
  // A live check, run between steps while the card still waits: @critic’s two turns came while the mention was held.
  assert.deepEqual(found(r.f, 'delivery-dropped'), [], 'before the Allow');
  allowHeld(r, { delivered: true });
  assert.deepEqual(found(r.f, 'delivery-dropped'), [], 'after the Allow');
});

test('delivery-dropped doesn’t call a mention dropped while the card it’s held on is still open at the end of the run', () => {
  const r = heldOnOpenCard();
  r.turn('critic', s(80), { prompt: '[Postbox] Nothing new in this room since your last turn.' });
  r.turn('critic', s(100), { prompt: '[Postbox] Nothing new in this room since your last turn.' });
  assert.deepEqual(found(r.f, 'delivery-dropped'), []);
});

test('delivery-dropped fires for a mention held on a card that its agent’s next two turns after the Allow don’t hold', () => {
  const r = heldOnOpenCard();
  allowHeld(r, { delivered: false });
  const out = found(r.f, 'delivery-dropped');
  assert.deepEqual(
    out.map((x) => x.key),
    ['delivery-dropped:critic:it_reply'],
  );
  // Due from the Allow, not from when @developer posted it.
  assert.match(out[0].evidence, new RegExp(new Date(s(50)).toISOString().replace(/[.]/g, '\\.')));
});

test('delivery-dropped doesn’t count a compaction summary or a meta line as the mention reaching its agent', () => {
  for (const flags of [{ isCompactSummary: true }, { isMeta: true }]) {
    const f = mentionRoom({ delivered: false });
    const r = { lines: /** @type {any} */ (f.transcripts.find((t) => t.handle === 'researcher')).lines };
    r.lines.push(JSON.stringify({ type: 'user', ...flags, timestamp: new Date(s(41)).toISOString(), message: { content: SUMMARY(ROUND_TWO) } }));
    assert.deepEqual(
      found(f, 'delivery-dropped').map((x) => x.key),
      ['delivery-dropped:researcher:it_round2'],
      JSON.stringify(flags),
    );
  }
});

test('each delivery check is in CHECKS with the requirements it serves beside its issue', () => {
  const by = Object.fromEntries(CHECKS.map((c) => [c.id, c]));
  for (const [id, reqs] of Object.entries({
    'ask-dropped': ['AT-1'],
    'delivery-dropped': ['DL-1', 'SW-2'],
    'unlabeled-repeat': ['DL-2', 'INV-4'],
    'marker-before-output': ['DL-3', 'INV-6'],
    'needs-mismatch': ['AT-4'],
  })) {
    assert.deepEqual(by[id]?.requirements, reqs, id);
    assert.equal(typeof by[id].issue, 'number', id);
  }
});
