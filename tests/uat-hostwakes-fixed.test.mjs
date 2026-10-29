// The hostwakes checks on a build with #439’s fix (PR #497), where a wake that needs a card while one waits is held on
// it: wake_agent answers with the hold, on a host too; Allow delivers it; Don’t allow tells its sender with a notice; and
// a card whose target got a turn another way is retired, its wake raising a fresh card if it still needs one. The texts
// are the ones #497’s server/wake-cards.mjs gives.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOSTWAKE_TRIGGERS, hopCards } from '../tools/uat/triggers-hostwakes.mjs';
import { check, facts, received, s, turn, wakeStream } from './uat-hostwakes-fixture.mjs';

const HELD =
  'Postbox is holding your message to @critic: @researcher’s request to wake @critic (since 10:00 UTC) is waiting for the person. It goes to @critic when they allow that, so don’t send it again; if they don’t, you’ll be told.';

/** Today’s fixture with developer’s hand-off held on the card instead of refused, and the card answered as given. */
function held({ answer, at, extraItems = [] }) {
  const f = facts({ allowedAt: null, extraItems });
  const items = f.state.items.th1;
  const card = items.find((it) => it.kind === 'hop');
  card.status = answer === 'allow' ? 'allowed' : 'declined';
  items.push({ kind: 'voice', text: answer === 'allow' ? 'Allowed: @researcher wakes @critic' : 'Didn’t allow @researcher to wake @critic', at });
  f.streams = [wakeStream('developer', s(100), 'critic', HELD)];
  return f;
}

test('#451 a hand-off held on a card that you then didn’t allow isn’t lost: its sender is told, in a turn after your answer', () => {
  const f = held({ answer: 'decline', at: s(400), extraItems: [turn('developer', s(402))] });
  f.now = s(1000);
  assert.deepEqual(check('refused-wake-lost').run(f), []);
});

test('#451 a held hand-off you didn’t allow, whose sender no turn tells, is still lost', () => {
  const f = held({ answer: 'decline', at: s(400) });
  f.now = s(1000);
  assert.equal(check('refused-wake-lost').run(f).length, 1);
});

test('#451 a retired card doesn’t borrow the Allow of the card raised again with the same wake', () => {
  const f = facts({ allowedAt: null });
  const items = f.state.items.th1;
  Object.assign(
    items.find((it) => it.kind === 'hop'),
    { status: 'retired', retiredAt: s(200), text: 'researcher to critic' },
  );
  items.push({ kind: 'hop', from: 'researcher', to: 'critic', at: s(210), pair: 2, status: 'allowed', text: 'researcher to critic' });
  items.push({ kind: 'voice', text: 'Allowed: @researcher wakes @critic', at: s(400) });
  const [retired, fresh] = hopCards(f);
  assert.deepEqual([retired.allowedAt, retired.answeredAt], [null, s(200)]);
  assert.deepEqual([fresh.allowedAt, fresh.answeredAt], [s(400), s(400)]);
});

test('#451 on a fixed build, phase 2’s hold shows: wake-held-on-card sees wake_agent answer that Postbox is holding it', () => {
  const f = held({ answer: 'allow', at: s(400) });
  const seen = HOSTWAKE_TRIGGERS['wake-held-on-card'].run(f);
  assert.equal(seen.length, 1);
  assert.match(seen[0].evidence, /@developer’s wake of @critic is held/);
});

test('#451 a held hand-off you allow within a minute is delivered after the Allow, not read as applied at once', () => {
  const f = held({ answer: 'allow', at: s(130), extraItems: [turn('critic', s(132))] });
  f.received = [received('critic', 'developer', s(131), 'developer to critic')];
  assert.equal(HOSTWAKE_TRIGGERS['held-wake-delivered-after-allow'].run(f).length, 1);
});

test('#451 a hand-off held on a card that still waits isn’t lost, however long the card waits, as in the 28 October run on a fixed build', () => {
  const f = facts({ allowedAt: null });
  f.streams = [wakeStream('developer', s(100), 'critic', HELD)];
  f.now = s(1000);
  assert.deepEqual(check('refused-wake-lost').run(f), []);
});

test('#451 a held hand-off whose card you allowed, and that never reached its target, is lost', () => {
  const f = held({ answer: 'allow', at: s(400) });
  f.now = s(1000);
  assert.equal(check('refused-wake-lost').run(f).length, 1);
});

test('#451 a held answer after an urgent note is still a hold: withUrgent puts the note first (server/mcp.mjs)', () => {
  const f = held({ answer: 'allow', at: s(400) });
  f.streams = [wakeStream('developer', s(100), 'critic', `[Postbox] URGENT: a subagent needs you.\n\n${HELD}`)];
  assert.equal(HOSTWAKE_TRIGGERS['wake-held-on-card'].run(f).length, 1);
});
