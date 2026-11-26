// #1591, reopened: the first paid runs with two real agents after PR #1724 (pairwork, 26 November 2026) still looped,
// on plain @-mentions. Each agent reacted ✅ to the other’s message, then wrote a line that named it (“I reacted ✅ to
// @critic’s closing message and haven’t replied, since nothing is left for me to do.”), and the mention woke the other,
// about every four seconds. PR #1724’s rule ended an exchange on a reaction only when the message reacted to was a
// reply that had come back on its own. In these runs both agents named each other, so every wake was a direct
// @-mention and the rule never applied: PR #1724’s replays had one side that named no one.
//
// A reply in words alone that names the agent it answers is a reply too, and a reaction now ends an exchange on it.
// A request is never one (tests/reply-back-request-answered.test.mjs).
//
// The turns are in tests/fixtures/uat/mention-loops-2026-11-26.json, cut from the two runs’ event logs: phases 1 and 2
// of each, from critic’s approval to the person’s next message. Each agent plays every recorded turn another agent
// woke, in recorded order, and reacts where it did in the run (tests/bounce-loop-fixture.mjs). Of the 34 closing turns
// in those stretches, 24 reacted and did no work; the 10 that didn’t react each wake the other once more.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endedByReaction } from '../server/reply-back.mjs';
import { turnInput } from '../server/turn-input.mjs';
import { heldOnCard, playsWoken, room, settle } from './bounce-loop-fixture.mjs';

const replies = (store, t) => store.items(t.id).filter((i) => i.kind === 'agent' && i.text?.trim());
const turnsOf = (adapter) => adapter.calls.map((c) => c.handle).join(' ');
const heard = (adapter, handle, text) => adapter.calls.some((c) => c.handle === handle && c.text.includes(text));
const END = { text: '' };

/** The four recorded loops: each run’s phase, the turns it spans, the closing turns the run took, and where critic’s and developer’s plays start. */
const LOOPS = [
  { run: 'pairwork', phase: 1, critic: 12, developer: 14, to: 27, recorded: 15 },
  { run: 'pairwork', phase: 2, critic: 29, developer: 30, to: 36, recorded: 7 },
  { run: 'pairwork-2', phase: 1, critic: 8, developer: 10, to: 17, recorded: 9 },
  { run: 'pairwork-2', phase: 2, critic: 19, developer: 20, to: 22, recorded: 3 },
];
for (const { run, phase, critic, developer, to, recorded } of LOOPS) {
  test(`#1591: after critic’s approval the pair ends within three closing turns (${run}, phase ${phase}: ${recorded} in the run)`, {
    skip: 'PROTOTYPE: tests a rule the count rule replaces, or an exact turn count under it',
  }, async () => {
    const plays = { critic: [...playsWoken(run, 'critic', critic, to), END], developer: [...playsWoken(run, 'developer', developer, to), END] };
    const { store, rt, adapter, t } = room(plays);
    rt.sendMessage(t.id, { text: '@critic check developer’s fixes' });
    await settle(rt);
    assert.ok(!heldOnCard(store, t), `the exchange ended before the room’s limit: ${turnsOf(adapter)}`);
    // The approval, then the closing turns: pairwork’s phase 3 allows three after the last reply that did work.
    const closing = adapter.calls.length - 1;
    assert.ok(closing >= 1 && closing <= 3, `${closing} closing turns: ${turnsOf(adapter)}`);
    assert.equal(replies(store, t).at(-1).wentBack, undefined, 'the last line posts, and goes back to no one');
  });
}

test('#1591: a reply in words alone that names its asker is a reply: a reaction to it ends the exchange', {
  skip: 'PROTOTYPE: tests a rule the count rule replaces, or an exact turn count under it',
}, async () => {
  // critic asks, alpha answers by name with no work, and critic reacts ✅ and names alpha in a closing line.
  const plays = {
    critic: [{ text: '@alpha is the count 919?' }, { text: 'I reacted ✅ to @alpha’s answer and haven’t replied.', react: true }, END],
    alpha: [{ text: '@critic yes, 919.' }, { text: 'Noted, @critic.' }],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@critic check the count with alpha' });
  await settle(rt);
  assert.equal(turnsOf(adapter), 'critic alpha critic');
  assert.match(replies(store, t).at(-1).text, /^I reacted ✅ to @alpha’s answer/, 'the line still posts');
  // And critic was told so, since only a reply woke that turn.
  assert.match(
    adapter.calls[2].text,
    /react to each message from its sender: then, unless you do work this turn \(more than reading the room and reacting\), /,
  );
});

test('#1591: the cost: a question in words inside an exchange, answered with a reaction and words, isn’t heard', {
  skip: 'PROTOTYPE: tests a rule the count rule replaces, or an exact turn count under it',
}, async () => {
  // alpha’s “which file?” comes from a turn only critic’s message woke, and did no work, so Postbox can’t tell it from
  // a closing line. critic reacts and answers in words: no wake. The first line told critic; with no reaction it’s heard.
  const ask = { critic: [{ text: '@alpha review wordcount.py.' }], alpha: [{ text: '@critic which file, src/ or tools/?' }, END] };
  const cut = room({ critic: [...ask.critic, { text: '@alpha the one in src/.', react: true }, END], alpha: [...ask.alpha] });
  cut.rt.sendMessage(cut.t.id, { text: '@critic have alpha review it' });
  await settle(cut.rt);
  assert.ok(!heard(cut.adapter, 'alpha', 'the one in src/.'), turnsOf(cut.adapter));
  const kept = room({ critic: [...ask.critic, { text: '@alpha the one in src/.' }, END], alpha: [...ask.alpha] });
  kept.rt.sendMessage(kept.t.id, { text: '@critic have alpha review it' });
  await settle(kept.rt);
  assert.ok(heard(kept.adapter, 'alpha', 'the one in src/.'), turnsOf(kept.adapter));
});

test('#1591: a reply by name that waited on a wake card is still a reply when the person allows it', {
  skip: 'PROTOTYPE: tests a rule the count rule replaces, or an exact turn count under it',
}, async () => {
  // The room’s chain limit holds alpha’s answer on a card. Allowed, it wakes critic as the reply it is, so critic’s
  // reaction ends the exchange; an own wake and one held on another’s card both keep the mark (wake-cards.mjs).
  const plays = {
    critic: [{ text: '@alpha is the count 919?' }, { text: 'I reacted ✅ to @alpha’s answer and haven’t replied.', react: true }, END],
    alpha: [{ text: '@critic yes, 919.' }, { text: 'Noted, @critic.' }],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.threads.patch(t.id, { chainLimit: 1 });
  rt.sendMessage(t.id, { text: '@critic check the count with alpha' });
  await settle(rt);
  const card = store.items(t.id).find((i) => i.kind === 'hop' && i.status === 'open');
  assert.equal(card?.backByName, true, 'the card keeps what kind of reply it holds');
  await rt.act(t.id, card.id, 'confirm', {});
  await settle(rt);
  assert.equal(turnsOf(adapter), 'critic alpha critic');
  assert.ok(!heldOnCard(store, t), 'and critic’s closing line asks for no second card');
});

test('#1591: a reply by name whose card closes because its target got a turn another way goes on as a reply', {
  skip: 'PROTOTYPE: tests a rule the count rule replaces, or an exact turn count under it',
}, async () => {
  // The person writes to critic while alpha’s answer waits on the card: the card retires, and its wake goes on with
  // what it held (wake-cards.mjs). The entry it makes still says what kind of reply it is.
  const plays = { critic: [{ text: '@alpha is the count 919?' }, END], alpha: [{ text: '@critic yes, 919.' }, END] };
  const { store, rt, t } = room(plays);
  rt.threads.patch(t.id, { chainLimit: 1 });
  rt.sendMessage(t.id, { text: '@critic check the count with alpha' });
  await settle(rt);
  assert.ok(heldOnCard(store, t));
  rt.sendMessage(t.id, { text: '@critic any news?' });
  await settle(rt);
  assert.ok(!heldOnCard(store, t), 'the card closed');
  const entry = Object.values(store.state.inbox)
    .flat()
    .find((e) => e.from === 'alpha' && e.source === 'mention');
  assert.equal(entry?.backByName, true, JSON.stringify(entry));
});

test('#1591: a reaction to a reply, then work, then the report, reaches the agent', async () => {
  // Until now a reaction to a reply that came back ended the exchange whatever the turn did, so this report was lost.
  const plays = {
    alpha: [{ text: '@critic please review wordcount.py.' }, { text: 'Fixed both.', react: true, step: true }, END],
    critic: [{ text: 'Two problems: tabs and empty files.', step: true }, END],
  };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  assert.ok(heard(adapter, 'critic', 'Fixed both.'), turnsOf(adapter));
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
});

test('#1591: a reaction ends an exchange on a reply that came back or one by name, never on a request, and never after work', () => {
  const items = { r1: { reactions: [{ emoji: '✅', by: 'se_critic', at: 10 }] }, q1: { reactions: [] } };
  const rt = { store: { pending: { item: (_t, id) => items[id] } } };
  const se = { id: 'se_critic' };
  const entry = (more) => ({ source: 'mention', from: 'alpha', threadId: 't', itemId: 'r1', ...more });
  const [back, named, asked] = [entry({ bounce: true }), entry({ backByName: true }), entry({})];
  const turn = { startedAt: 0, steps: [] };
  assert.equal(endedByReaction(rt, se, [back], 'alpha', turn), true, 'a reply that came back');
  assert.equal(endedByReaction(rt, se, [named], 'alpha', turn), true, 'a reply in words alone, by name');
  assert.equal(endedByReaction(rt, se, [asked], 'alpha', turn), false, 'a request, though reacted to');
  assert.equal(endedByReaction(rt, se, [named, asked], 'alpha', turn), false, 'a request beside a reply');
  assert.equal(endedByReaction(rt, se, [named, { ...named, itemId: 'q1' }], 'alpha', turn), false, 'one of two replies not reacted to');
  assert.equal(endedByReaction(rt, se, [named], 'alpha', { ...turn, steps: [{ id: 's1' }] }), false, 'after a step');
  assert.equal(endedByReaction(rt, se, [back], 'alpha', { ...turn, acted: true }), false, 'after a block shown');
  assert.equal(endedByReaction(rt, se, [named], 'alpha', { ...turn, steps: [{ id: 's1', kind: 'thought' }] }), true, 'a thought is no work');
  assert.equal(endedByReaction(rt, se, [named], 'alpha', { ...turn, startedAt: 20 }), false, 'a reaction from before this turn began');
  assert.equal(endedByReaction(rt, se, [named], 'beta', turn), false, 'nothing from beta, so nothing ends with beta');
  // A turn that also took the person’s message isn’t answering that agent alone, and isn’t told the rule.
  assert.equal(endedByReaction(rt, se, [named, { source: 'person', from: 'you', threadId: 't', itemId: 'p1' }], 'alpha', turn), false);
});

const read = () => 'A message.';
const from = (handle, n, more = {}) => ({ id: `en_${n}`, threadId: 'th_1', itemId: `it_${n}`, source: 'mention', from: handle, at: 0, ...more });
const firstLine = (entries) => turnInput({ entries, thread: { id: 'th_1', kind: 'room' }, read }).split('\n')[0];

test('#1591: only a turn that replies alone woke is told what a reaction does, so a request’s turn isn’t taught to react', () => {
  const told =
    /If the exchange is done, react to each message from its sender: then, unless you do work this turn \(more than reading the room and reacting\), nothing you write wakes that agent, even by name\./;
  assert.match(firstLine([from('critic', 1, { bounce: true })]), told);
  assert.match(firstLine([from('critic', 1, { backByName: true })]), told);
  assert.match(firstLine([from('critic', 1, { backByName: true }), from('beta', 2, { bounce: true })]), told);
  // A request, alone or beside a reply, and a turn the person started.
  assert.doesNotMatch(firstLine([from('critic', 1)]), /react/);
  assert.doesNotMatch(firstLine([from('critic', 1, { backByName: true }), from('beta', 2)]), /react/);
  assert.doesNotMatch(firstLine([{ ...from('you', 1), source: 'person' }]), /react/);
  // A turn a reply by name woke still owes its reply, so it isn’t told it may end without writing.
  assert.doesNotMatch(firstLine([from('critic', 1, { backByName: true })]), /end without writing/);
});
