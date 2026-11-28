// #1974: two agents kept waking each other up to the chain’s cap, each turn reacting ✅ to the other’s reply and then
// naming it in a closing line (“I reacted ✅ to @critic’s message.”). An @-mention always wakes (the owner’s ruling on
// PR #1823), so the woken agent is told instead: the turn that woke it reacted to its reply and did no work. The
// assets-room recording is in tests/fixtures/uat/ack-loops-2026-11-23.json, played as tests/bounce-loop-fixture.mjs plays it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reactedOnlyFrom } from '../server/reply-back.mjs';
import { playsFrom, room, settle } from './bounce-loop-fixture.mjs';

const told = (handle) => `@${handle} reacted to your reply and did no work. If nothing is asked of you, react and end with no words.`;
const turnsOf = (adapter) => adapter.calls.map((c) => c.handle).join(' ');

test('#1974: an agent woken by a turn that only reacted to its reply is told so on its first line (assets-room)', async () => {
  const { rt, adapter, t } = room({ researcher: playsFrom('assets-room', 'researcher', 44), critic: playsFrom('assets-room', 'critic', 45) });
  rt.sendMessage(t.id, { text: '@researcher quote Postbox’s refusal of your stale write word for word' });
  await settle(rt);
  const [, asked, , named] = adapter.calls;
  // researcher’s first answer, which reacted to nothing, wakes critic as any mention does.
  assert.equal(asked.handle, 'critic', turnsOf(adapter));
  assert.ok(!asked.text.includes('reacted to your reply'), asked.text);
  // Its fourth turn: researcher reacted ✅ to critic’s acknowledgment and wrote “I reacted ✅ to @critic's message.”
  assert.equal(named.handle, 'critic', turnsOf(adapter));
  assert.ok(named.text.includes('I reacted ✅ to @critic'), named.text);
  assert.ok(named.text.split('\n')[0].includes(told('researcher')), named.text);
});

test('#1974: a wake from a turn that reacted and did work, or that didn’t react, says nothing of a reaction', async () => {
  const plays = {
    alpha: [
      { text: '@beta draft the plan.' },
      { text: 'I ran the checks. @beta, the plan holds.', react: true, step: true },
      { text: '@beta one more: add the rollback step.' },
      { text: 'Thanks @beta.', react: true },
      { text: '' },
    ],
    beta: [{ text: 'Drafted it. @alpha please check it.' }, { text: '@alpha noted.' }, { text: '@alpha added it.' }, { text: '' }],
  };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha have beta draft the plan' });
  await settle(rt);
  const beta = adapter.calls.filter((c) => c.handle === 'beta');
  assert.equal(beta.length, 4, turnsOf(adapter));
  assert.ok(beta[1].text.includes('the plan holds'), beta[1].text);
  assert.ok(!beta[1].text.includes('reacted to your reply'), 'alpha did work');
  assert.ok(beta[2].text.includes('add the rollback step'), beta[2].text);
  assert.ok(!beta[2].text.includes('reacted to your reply'), 'alpha didn’t react');
  assert.ok(beta[3].text.split('\n')[0].includes(told('alpha')), beta[3].text);
});

// reactedOnlyFrom reads the entries a turn took and whom each entry’s item’s turn reacted to (`reactedOnly`). A room
// can’t mark a bounce today, since its turn named no one and markReacted marks only a turn that mentioned, so these
// call it directly.
const markedFor = (marked) => (e) => (marked.includes(e.itemId) ? ['beta'] : undefined);

test('#1974: a reply that came back never gets the line, even from a turn that reacted to the reply', () => {
  const mention = { source: 'mention', from: 'alpha', itemId: 'i1' };
  // The control: the same entry as a direct @-mention gets it.
  assert.deepEqual(reactedOnlyFrom([mention], markedFor(['i1']), 'beta'), ['alpha']);
  // A bounce is told how its exchange ends already (turn-input.mjs, replyGoes).
  assert.deepEqual(reactedOnlyFrom([{ ...mention, bounce: true }], markedFor(['i1']), 'beta'), []);
});

test('#1974: a waker that sent a real @-request and a marked closing line in one batch gets no line', () => {
  const request = { source: 'mention', from: 'alpha', itemId: 'i1' };
  const closing = { source: 'mention', from: 'alpha', itemId: 'i2' };
  // The control: the closing line alone gets it.
  assert.deepEqual(reactedOnlyFrom([closing], markedFor(['i2']), 'beta'), ['alpha']);
  // With the request beside it, something is asked of beta, so not every entry from alpha is such a mention.
  assert.deepEqual(reactedOnlyFrom([request, closing], markedFor(['i2']), 'beta'), []);
  assert.deepEqual(reactedOnlyFrom([closing, request], markedFor(['i2']), 'beta'), []);
});
