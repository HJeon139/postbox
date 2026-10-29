// The delivery checks (#508, designs/508/testing-strategy.md, “Triggers, checks and seeds to add”): each fires on a
// room with its defect and stays silent on one without, read from what `main` records. The rooms are hand-built from
// the shapes UAT runs record (tests/delivery-fixture.mjs says why, and which).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKS, runChecks } from '../tools/uat/checks.mjs';
import { DRAFT, ROUND_TWO, room, T0 } from './delivery-fixture.mjs';

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

/** Claude Code’s compaction summary, hand-written in its shape: it retells the conversation, a mention included. */
const SUMMARY = (text) =>
  `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary request and intent: ${text}`;

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

test('unlabeled-repeat doesn’t count a compaction summary or a meta line as a second prompt', () => {
  for (const flags of [{ isCompactSummary: true }, { isMeta: true }]) {
    const r = room();
    r.agent('researcher');
    r.add({ id: 'it_draft', at: s(1), kind: 'user', text: DRAFT });
    r.turn('researcher', s(2), { prompt: DRAFT });
    r.written('researcher', s(20), SUMMARY(DRAFT), flags);
    assert.deepEqual(found(r.f, 'unlabeled-repeat'), [], JSON.stringify(flags));
  }
});

/** The person’s request, given whole in two of @researcher’s prompts; the second labeled, or not. */
function repeatRoom(second) {
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_draft', at: s(1), kind: 'user', text: DRAFT });
  r.turn('researcher', s(2), { prompt: DRAFT });
  r.turn('researcher', s(30), { prompt: second });
  return r.f;
}

test('unlabeled-repeat fires when a message comes whole a second time without a resend label', () => {
  const out = found(repeatRoom(`[Postbox] What happened in this room since your last turn:\n\nYou: ${DRAFT}`), 'unlabeled-repeat');
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /in 2 of @researcher’s prompts/);
  assert.deepEqual(out[0].requirements, ['DL-2', 'INV-4']);
});

test('unlabeled-repeat stays silent on a resend that says it’s one', () => {
  const f = repeatRoom(`[Postbox] Your last turn failed before it started, so this was resent; check what ran.\n\nYou: ${DRAFT}`);
  assert.deepEqual(found(f, 'unlabeled-repeat'), []);
});

test('unlabeled-repeat stays silent on a topic thread’s first turn, which gives its starting message on purpose', () => {
  // The line server/runtime.mjs’s topicRootLine writes for an agent’s first turn in a topic thread (envelope item 2).
  for (const who of ['your message', '@critic’s message']) {
    const f = repeatRoom(`[Postbox] You’re answering in the thread “Release checklist” (thread th_topic). This thread started from ${who}: ${DRAFT}`);
    assert.deepEqual(found(f, 'unlabeled-repeat'), [], who);
  }
});

test('unlabeled-repeat stays silent on a message that only quotes the start of another', () => {
  // The p0 run’s @critic restated the person’s request in its own words: its start matched, its whole didn’t.
  const f = repeatRoom(`[Postbox] @critic: ${DRAFT.slice(0, 80)} Post the full list first, then six rounds with @critic.`);
  assert.deepEqual(found(f, 'unlabeled-repeat'), []);
});

test('two separate addressed items with identical text and distinct ids, delivered once each, are not repeats', () => {
  // gpt’s regression (#523 review): each prompt names the item it delivers.
  const r = room();
  r.agent('critic');
  const text = '@critic please review the latest changes and report blocking problems.';
  r.add({ id: 'it_first', at: s(1), kind: 'user', text });
  r.turn('critic', s(2), { prompt: `Message it_first: ${text}` });
  r.add({ id: 'it_second', at: s(20), kind: 'user', text });
  r.turn('critic', s(21), { prompt: `Message it_second: ${text}` });
  assert.deepEqual(runChecks(r.f, { only: ['unlabeled-repeat'] }), [], 'each item was delivered exactly once');
});

test('unlabeled-repeat doesn’t count a prompt from before the item existed', () => {
  const r = room();
  r.agent('researcher');
  r.turn('researcher', s(1), { prompt: `@critic said: ${DRAFT}` });
  r.add({ id: 'it_draft', at: s(10), kind: 'user', text: DRAFT });
  r.turn('researcher', s(20), { prompt: DRAFT });
  assert.deepEqual(found(r.f, 'unlabeled-repeat'), []);
});

test('unlabeled-repeat says it couldn’t tell two same-text items apart when their prompts name neither', () => {
  // The second prompt may be the second item’s delivery, or the first item’s again: not a finding, unverified.
  const r = room();
  r.agent('critic');
  const text = '@critic please review the latest changes and report blocking problems.';
  r.add({ id: 'it_first', at: s(1), kind: 'user', text });
  r.turn('critic', s(2), { prompt: text });
  r.add({ id: 'it_second', at: s(20), kind: 'user', text });
  r.turn('critic', s(21), { prompt: text });
  const out = found(r.f, 'unlabeled-repeat');
  assert.deepEqual(
    out.map((x) => [x.key, !!x.unverified]),
    [['unlabeled-repeat:unverified:critic:it_first', true]],
  );
  assert.match(out[0].evidence, /it_second/);
});

test('two same-text items both made before either prompt, given once each naming neither, are both unverified', () => {
  // gpt’s regression (#523 review, round 3): either prompt could be either item’s, so neither item is a finding.
  const r = room();
  r.agent('critic');
  const text = '@critic please review the latest changes and report blocking problems.';
  r.add({ id: 'it_first', at: s(1), kind: 'user', text });
  r.add({ id: 'it_second', at: s(2), kind: 'user', text });
  r.turn('critic', s(10), { prompt: text });
  r.turn('critic', s(20), { prompt: text });
  const out = found(r.f, 'unlabeled-repeat');
  assert.equal(out.filter((x) => !x.unverified).length, 0, JSON.stringify(out));
  assert.deepEqual(
    out.map((x) => [x.key, !!x.unverified]),
    [
      ['unlabeled-repeat:unverified:critic:it_first', true],
      ['unlabeled-repeat:unverified:critic:it_second', true],
    ],
  );
  assert.match(out[1].evidence, /it_first/);
});

test('unlabeled-repeat still fires for an item given twice by its id beside a same-text one given once', () => {
  const r = room();
  r.agent('critic');
  const text = '@critic please review the latest changes and report blocking problems.';
  r.add({ id: 'it_first', at: s(1), kind: 'user', text });
  r.turn('critic', s(2), { prompt: `Message it_first: ${text}` });
  r.add({ id: 'it_second', at: s(20), kind: 'user', text });
  r.turn('critic', s(21), { prompt: `Message it_second: ${text}` });
  r.turn('critic', s(40), { prompt: `Message it_first: ${text}` });
  assert.deepEqual(
    found(r.f, 'unlabeled-repeat').map((x) => x.key),
    ['unlabeled-repeat:critic:it_first'],
  );
});

/** @researcher’s marker moves as its turn’s prompt is built; the turn then writes something, or nothing. */
function markerRoom({ output }) {
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_a', at: s(1), kind: 'user', text: 'First message' });
  r.marker('researcher', null, s(0));
  r.marker('researcher', 'it_a', s(10));
  r.turn('researcher', s(10) + 3, { prompt: 'First message', output });
  return r.f;
}

test('marker-before-output fires when the marker moved for a turn that wrote nothing', () => {
  // Cut after its init, as tools/uat/fault-launcher.mjs cuts a turn: no recorded failing turn exists yet.
  const out = found(markerRoom({ output: false }), 'marker-before-output');
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /from the start to it_a/);
  assert.deepEqual(out[0].requirements, ['DL-3', 'INV-6']);
});

test('marker-before-output stays silent when the turn the marker moved for wrote something', () => {
  assert.deepEqual(found(markerRoom({ output: true }), 'marker-before-output'), []);
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
