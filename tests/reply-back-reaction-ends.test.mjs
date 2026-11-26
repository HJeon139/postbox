// #1591, reopened: the first paid runs with two real agents after PR #1724 (pairwork, 26 November 2026) still looped,
// on plain @-mentions. Each agent reacted ✅ to the other’s message, then wrote a line that named it (“I reacted ✅ to
// @critic’s closing message and haven’t replied, since nothing is left for me to do.”), and the mention woke the other,
// about every four seconds. PR #1724’s rule ended an exchange on a reaction only when the message reacted to was a
// reply that had come back. In these runs both agents named each other every time, so every wake was a direct
// @-mention, and the rule never applied: its replays had one side that named no one.
//
// The turns are in tests/fixtures/uat/mention-loops-2026-11-26.json, cut from the two runs’ event logs, from critic’s
// approval to the person’s next message. Each agent plays its own recorded replies in order, as the room wakes it, and
// reacts where it did in the run (tests/bounce-loop-fixture.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnInput } from '../server/turn-input.mjs';
import { heldOnCard, playsMentioned, room, settle } from './bounce-loop-fixture.mjs';

const replies = (store, t) => store.items(t.id).filter((i) => i.kind === 'agent' && i.text?.trim());
const turnsOf = (adapter) => adapter.calls.map((c) => c.handle).join(' ');
const heard = (adapter, handle, text) => adapter.calls.some((c) => c.handle === handle && c.text.includes(text));
const END = { text: '' };
const work = (text, more = {}) => ({ text, step: true, ...more });

test('#1591: two agents that react, then name each other in a closing line, end there (pairwork, the first run)', async () => {
  // From critic’s line after its approval: 11 closing turns in the run, each one woken by a direct @-mention.
  const plays = { critic: playsMentioned('pairwork', 'critic', 15), developer: playsMentioned('pairwork', 'developer', 17) };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@critic is the review closed?' });
  await settle(rt);
  assert.ok(!heldOnCard(store, t), `the exchange ended before the room’s limit: ${turnsOf(adapter)}`);
  // critic names developer, and developer reacts ✅ and writes “I reacted ✅ to @critic’s closing note”: that wakes no one.
  assert.equal(turnsOf(adapter), 'critic developer');
  const last = replies(store, t).at(-1);
  assert.match(last.text, /^The review is closed\. I reacted ✅ to @critic's closing note and haven't replied/, 'its line still posts');
  assert.equal(last.wentBack, undefined);
});

test('#1591: the same in the second run, from the approval', async () => {
  const plays = { critic: playsMentioned('pairwork-2', 'critic', 8), developer: playsMentioned('pairwork-2', 'developer', 10) };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@critic check developer’s fixes' });
  await settle(rt);
  assert.ok(!heldOnCard(store, t), `the exchange ended before the room’s limit: ${turnsOf(adapter)}`);
  // critic’s approval did work, so it reaches developer, whose “I’ll react … instead of replying” ends it.
  assert.equal(turnsOf(adapter), 'critic developer');
});

test('#1591: a 👍 on a request, then the work and its report, still reaches the agent that asked', async () => {
  // A reaction to a request may come before the work it asks for: only a turn that did no work ends on one.
  const plays = {
    alpha: [{ text: '@critic please review wordcount.py.' }, END],
    critic: [work('@alpha reviewed: whitespace-only input prints 0, and a missing file exits 1.', { react: true })],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  assert.ok(heard(adapter, 'alpha', 'reviewed: whitespace-only input'), turnsOf(adapter));
  const named = { alpha: [{ text: '@critic please review wordcount.py.' }, END], critic: [work('Reviewed: a missing file exits 1.', { react: true })] };
  const again = room(named);
  again.rt.sendMessage(again.t.id, { text: '@alpha ask critic for a review' });
  await settle(again.rt);
  assert.deepEqual(replies(again.store, again.t).at(-1).wentBack, ['alpha'], 'and with no @, it goes back');
  assert.ok(!heldOnCard(store, t));
});

test('#1591: a reaction to a reply that came back, then work, then the report, reaches the agent too', async () => {
  // Until now a reaction to a reply that came back ended the exchange whatever the turn did, so this report was lost.
  const plays = {
    alpha: [{ text: '@critic please review wordcount.py.' }, work('Fixed both.', { react: true }), END],
    critic: [work('Two problems: tabs and empty files.'), END],
  };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  assert.ok(heard(adapter, 'critic', 'Fixed both.'), turnsOf(adapter));
});

test('#1591: a question to the same agent, with no reaction, still wakes it from a turn that only writes', async () => {
  const plays = {
    alpha: [{ text: '@critic please review wordcount.py.' }, { text: 'The one in src/.' }, END],
    critic: [{ text: '@alpha which wordcount.py, the one in src/ or in tools/?' }, END],
  };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  assert.ok(heard(adapter, 'alpha', 'which wordcount.py'), turnsOf(adapter));
  assert.ok(heard(adapter, 'critic', 'The one in src/.'), turnsOf(adapter));
});

test('#1591: after a reaction in a turn that only writes, an @-mention of another agent still hands off', async () => {
  const plays = {
    critic: [{ text: '@alpha check the counts.' }, END],
    alpha: [{ text: 'Done with my part. @beta, your turn: check the table.', react: true }],
    beta: [{ text: 'beta: the table holds.' }],
  };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@critic have alpha check the counts, then beta the table' });
  await settle(rt);
  assert.ok(heard(adapter, 'beta', 'your turn: check the table'), turnsOf(adapter));
  assert.ok(!heard(adapter, 'critic', 'Done with my part.'), 'and critic, whose message alpha reacted to, isn’t woken');
});

const read = () => 'A message.';
const from = (handle, n, bounce = false) => ({ id: `en_${n}`, threadId: 'th_1', itemId: `it_${n}`, source: 'mention', from: handle, at: 0, bounce });
const firstLine = (entries) => turnInput({ entries, thread: { id: 'th_1', kind: 'room' }, read }).split('\n')[0];

test('#1591: every turn another agent woke is told what a reaction does, a direct @-mention’s turn included', () => {
  const told = /If the exchange is done, react to the message: then, unless you do work this turn, nothing you write wakes its sender, even by name\./;
  assert.match(firstLine([from('critic', 1)]), told);
  assert.match(firstLine([from('critic', 1, true)]), told);
  assert.match(firstLine([from('critic', 1), from('beta', 2, true)]), told);
  // Not a turn the person started.
  assert.doesNotMatch(firstLine([{ ...from('you', 1), source: 'person' }]), /react to the message/);
});
