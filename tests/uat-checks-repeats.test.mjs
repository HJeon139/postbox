// unlabeled-repeat (#508, server/room-checks-delivery.mjs): the same delivery whole in two of an agent’s prompts, the
// later one without a resend label. Each test fires on a room with the defect and stays silent on one without; the
// rooms are hand-built from the shapes UAT runs record (tests/delivery-fixture.mjs says why, and which). Moved from
// tests/uat-checks-delivery.test.mjs for size.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { DRAFT, room, SUMMARY, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;
const found = (f, id) => runChecks(f, { only: [id] });

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

test('unlabeled-repeat doesn’t count Retry’s resend, which sends the same message again by design (#151)', () => {
  // The agent’s reply to DRAFT failed; the person pressed Retry (server/runtime.mjs’s retry), which patches the failed
  // reply to retried and sends DRAFT again, with no label of its own.
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_draft', at: s(1), kind: 'user', text: DRAFT });
  r.turn('researcher', s(2), { prompt: DRAFT, output: false });
  r.add({
    id: 'it_failed',
    at: s(10),
    kind: 'agent',
    handle: 'researcher',
    sessionId: 'se_researcher',
    text: '',
    status: 'failed',
    error: 'The agent stopped unexpectedly.',
  });
  r.patch('it_failed', { status: 'retried' });
  r.turn('researcher', s(30), { prompt: DRAFT });
  assert.deepEqual(found(r.f, 'unlabeled-repeat'), []);
  // Without the Retry, the same second prompt is a repeat.
  const g = room();
  g.agent('researcher');
  g.add({ id: 'it_draft', at: s(1), kind: 'user', text: DRAFT });
  g.turn('researcher', s(2), { prompt: DRAFT, output: false });
  g.add({
    id: 'it_failed',
    at: s(10),
    kind: 'agent',
    handle: 'researcher',
    sessionId: 'se_researcher',
    text: '',
    status: 'failed',
    error: 'The agent stopped unexpectedly.',
  });
  g.turn('researcher', s(30), { prompt: DRAFT });
  assert.equal(found(g.f, 'unlabeled-repeat').length, 1);
});
