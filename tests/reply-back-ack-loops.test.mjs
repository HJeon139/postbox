// #1591: agents kept answering each other’s replies with nothing to add, in five UAT runs in two days. The turns here
// are recorded in tests/fixtures/uat/ack-loops-2026-11-23.json, cut from the event logs of the batch 9–10 UAT’s two
// rooms (assets-room and holdstill), which both stopped at the run’s turn cap. They aren’t replays: each agent plays
// its own recorded replies in order, as the room wakes it, and reacts where it did in the run
// (tests/bounce-loop-fixture.mjs). The room’s chain limit, set low, is what a test that still loops runs into.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteAnswer } from '../server/empty-reply.mjs';
import { endedExchange } from '../server/reply-back.mjs';
import { heldOnCard, playsFrom, playsWith, room, settle } from './bounce-loop-fixture.mjs';

const replies = (store, t) => store.items(t.id).filter((i) => i.kind === 'agent' && i.text?.trim());
const turnsOf = (adapter) => adapter.calls.map((c) => c.handle).join(' ');

test('#1591: an agent that reacts, then names the agent it reacted to, doesn’t wake it again (assets-room)', async () => {
  // From turn 44: researcher answers the person, critic acknowledges, and from there researcher reacts ✅ to each
  // acknowledgment and writes “I reacted ✅ to @critic’s acknowledgment.”, which woke critic by its mention, 20 times.
  const { store, rt, adapter, t } = room({ researcher: playsFrom('assets-room', 'researcher', 44), critic: playsFrom('assets-room', 'critic', 45) });
  rt.sendMessage(t.id, { text: '@researcher quote Postbox’s refusal of your stale write word for word' });
  await settle(rt);
  assert.ok(!heldOnCard(store, t), `the exchange ended before the room’s limit: ${turnsOf(adapter)}`);
  // Since the paid runs of 26 November it ends a turn sooner: critic reacted ✅ to researcher’s @-mention and did no
  // work, so its “Acknowledged.” goes back to no one, and researcher’s line is never written.
  assert.equal(turnsOf(adapter), 'researcher critic');
  const last = replies(store, t).at(-1);
  assert.match(last.text, /^Acknowledged\. The refusal names version 2/, 'the line still posts');
  assert.equal(last.wentBack, undefined);
});

test('#1591: the same loop between two of three agents ends on the reaction (holdstill)', async () => {
  // developer and researcher: developer reacted ✅ to each of researcher’s replies and wrote “I reacted ✅ to
  // @researcher’s message and didn’t reply.”, 47 times, and researcher’s answer to that mention went back each time.
  const plays = { developer: playsWith('holdstill', 'developer', 'researcher', 9), researcher: playsWith('holdstill', 'researcher', 'developer', 10) };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@developer show a small app' });
  await settle(rt);
  assert.ok(!heldOnCard(store, t), `the exchange ended before the room’s limit: ${turnsOf(adapter)}`);
  // developer names researcher, researcher names developer back, and developer reacts ✅ and names researcher: no wake.
  assert.equal(turnsOf(adapter), 'developer researcher developer');
});

test('#1591: after a reaction to one agent’s reply, an @-mention of another agent still hands off', async () => {
  const plays = {
    critic: [{ text: '@alpha check the counts.' }, { text: 'Thanks. @beta, your turn: check the table.', react: true }],
    alpha: [{ text: 'alpha: the counts hold.' }],
    beta: [{ text: 'beta: the table holds.' }],
  };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@critic have alpha check the counts, then beta the table' });
  await settle(rt);
  assert.ok(
    adapter.calls.some((c) => c.handle === 'beta' && c.text.includes('your turn: check the table')),
    turnsOf(adapter),
  );
});

test('#1591: a 👍 on a request, then only words to the agent that asked, wakes no one, and the turn was told so', async () => {
  // The rule’s cost, since the paid runs of 26 November: a reaction in a turn that does no work ends the exchange, after
  // a direct @-mention too. In the stored runs all 98 such turns were closing lines; a question needs no reaction.
  const plays = {
    alpha: [{ text: '@critic please review wordcount.py.' }, { text: 'The one in src/.' }],
    critic: [{ text: '@alpha which wordcount.py, the one in src/ or in tools/?', react: true }, { text: '' }],
  };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  assert.equal(turnsOf(adapter), 'alpha critic');
  assert.match(adapter.calls[1].text, /react to the message: then, unless you do work this turn, nothing you write wakes its sender, even by name\./);
});

test('#1591: agents that write “I’m ending without a reply” end at the second such line in a row (holdstill)', async () => {
  // critic and researcher, about 50 turns each with no tool call: each took the other’s reply that came back and wrote
  // “Nothing here is for me to act on, so I’m ending without a reply.”, which posted as its reply and went back.
  const plays = { researcher: playsWith('holdstill', 'researcher', 'critic', 6), critic: playsWith('holdstill', 'critic', 'researcher') };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@researcher write a long reply on how word counts differ between tools' });
  await settle(rt);
  assert.ok(!heldOnCard(store, t), `the exchange ended before the room’s limit: ${turnsOf(adapter)}`);
  // researcher names critic, and critic’s answer goes back (#1518). Then each writes one line that only writes, which
  // is delivered, and researcher’s second in a row ends it.
  assert.equal(turnsOf(adapter), 'researcher critic researcher critic researcher');
  const said = replies(store, t);
  assert.deepEqual(
    said.slice(2).map((i) => [i.handle, i.wentBack, i.wordsOnly]),
    [
      ['researcher', ['critic'], ['critic']],
      ['critic', ['researcher'], ['researcher']],
      ['researcher', undefined, ['critic']],
    ],
  );
  assert.equal(said.at(-1).text, "Nothing here is for me to act on, so I'm ending without a reply.", 'its line still posts');
});

test('#1591: an agent is told when its next reply that only writes will wake no one', async () => {
  const plays = { researcher: playsWith('holdstill', 'researcher', 'critic', 6), critic: playsWith('holdstill', 'critic', 'researcher') };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@researcher write a long reply on how word counts differ between tools' });
  await settle(rt);
  const [asked, back, again] = [adapter.calls[1].text, adapter.calls[2].text, adapter.calls[4].text];
  assert.match(
    asked,
    /Your reply posts there and goes back to @researcher\. @-mention another agent to hand off to them instead\. If the exchange is done, react to the message: /,
  );
  // Its first reply after one came back goes back as any does, and a reaction or nothing at all ends the exchange.
  assert.match(back, /Your reply posts there and goes back to @critic\. @-mention another agent to hand off to them instead\. If the exchange is done, /);
  assert.match(
    back,
    /react to the message: then, unless you do work this turn, nothing you write wakes its sender, even by name\. You can also end without writing anything\.\n/,
  );
  assert.match(again, /Your reply posts there\. Your last reply to @critic only wrote, so this one goes back to @critic only if you do work this turn /);
  assert.match(
    again,
    /\(more than reading the room and reacting\): a second in a row to the same agent that only writes doesn’t wake it, so @-mention whoever must act on it\b/,
  );
});

test('#1591: agents at work still answer each other, however many replies came back before (#1523)', async () => {
  // A review loop: critic finds something each round and alpha fixes it. No one @-mentions after the first request.
  const work = (text) => ({ text, step: true });
  const plays = {
    alpha: [{ text: '@critic please review wordcount.py.' }, work('Fixed the tabs case.'), work('Fixed the empty file case.'), { text: 'Thanks.' }],
    critic: [work('Tabs count as words.'), work('An empty file prints nothing.'), work('Both hold now.'), { text: 'Any time.' }],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  // Then the pleasantries: one from each is delivered, and alpha’s second “Thanks.” in a row ends it.
  assert.equal(turnsOf(adapter), 'alpha critic alpha critic alpha critic alpha critic alpha');
  const went = replies(store, t).map((i) => [i.text, i.wentBack]);
  assert.deepEqual(went.slice(1), [
    ['Tabs count as words.', ['alpha']],
    ['Fixed the tabs case.', ['critic']],
    ['An empty file prints nothing.', ['alpha']],
    ['Fixed the empty file case.', ['critic']],
    ['Both hold now.', ['alpha']],
    ['Thanks.', ['critic']],
    ['Any time.', ['alpha']],
    ['Thanks.', undefined],
  ]);
});

test('#1591: work between two replies that only write starts the count again', async () => {
  const work = (text) => ({ text, step: true });
  const plays = {
    alpha: [
      { text: '@beta draft the plan.' },
      { text: 'Add a rollback step.' },
      work('I checked it against the runbook: one gap.'),
      { text: 'Good, that closes it.' },
      { text: '' },
    ],
    beta: [work('Drafted the plan.'), work('Added the rollback step.'), work('Closed the gap.'), work('Filed it.')],
  };
  const { store, rt, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha have beta draft the plan' });
  await settle(rt);
  const went = Object.fromEntries(replies(store, t).map((i) => [i.text, i.wentBack]));
  assert.deepEqual(went['Add a rollback step.'], ['beta'], 'the first that only writes');
  assert.deepEqual(went['Good, that closes it.'], ['beta'], 'and the next one, after a reply that did work');
});

// The exchanges the integrator’s review of PR #1724 found cut when an agent’s first reply that only wrote went back to
// no one. Each depends on one such reply reaching the other agent, with no @-mention.
const END = { text: '' };
const heard = (adapter, handle, text) => adapter.calls.some((c) => c.handle === handle && c.text.includes(text));
const CUT_CASES = [
  {
    name: 'a follow-up question, and its answer',
    ask: '@alpha ask beta which file holds the changelog',
    plays: {
      alpha: [{ text: '@beta which file holds the changelog?' }, { text: 'Which section?' }, END],
      beta: [{ text: 'It’s CHANGELOG.md.' }, { text: 'Under Unreleased.' }],
    },
    reaches: [
      ['beta', 'Which section?'],
      ['alpha', 'Under Unreleased.'],
    ],
  },
  {
    name: 'a reviewer’s “Looks good, ship it.” after a fix',
    ask: '@alpha build it and get critic’s review',
    plays: {
      alpha: [{ text: '@critic please review wordcount.py.', step: true }, { text: 'Fixed both.', step: true }, { text: 'Shipped.', step: true }, END],
      critic: [{ text: 'Two problems: tabs and empty files.', step: true }, { text: 'Looks good, ship it.' }, END],
    },
    reaches: [['alpha', 'Looks good, ship it.']],
  },
  {
    name: 'the answer to a clarifying question',
    ask: '@alpha have beta add the changelog entry',
    plays: {
      alpha: [{ text: '@beta add the entry for the fix to the changelog.' }, { text: 'Under Unreleased.' }, END],
      beta: [{ text: 'Which section does it go under?' }, { text: 'Added it under Unreleased.', step: true }],
    },
    reaches: [['beta', 'Under Unreleased.']],
  },
  {
    name: 'a hand-off in words, with no @',
    ask: '@alpha have beta draft the plan, then run the tests',
    plays: {
      alpha: [{ text: '@beta draft the plan.' }, { text: 'Good. beta, now run the tests and report.' }, END],
      beta: [
        { text: 'Drafted the plan.', step: true },
        { text: 'Tests pass.', step: true },
      ],
    },
    reaches: [['beta', 'now run the tests']],
  },
];
for (const { name, ask, plays, reaches } of CUT_CASES) {
  test(`#1591: one reply that only writes still reaches the other agent: ${name}`, async () => {
    const { store, rt, adapter, t } = room(plays);
    rt.sendMessage(t.id, { text: ask });
    await settle(rt);
    for (const [handle, text] of reaches) assert.ok(heard(adapter, handle, text), `${handle} heard “${text}”: ${turnsOf(adapter)}`);
    assert.ok(!heldOnCard(store, t));
  });
}

test('#1591: a discussion in words only ends at the fifth message, unless an agent @-mentions', async () => {
  const alpha = (third) => [{ text: '@beta I’d cache at the edge. Objections?' }, { text: 'Per-user data is 5%; split it?' }, { text: third }, END];
  const beta = () => [{ text: 'Edge fails for per-user data.' }, { text: 'Split works if the keys differ.' }, { text: 'Then we agree.' }];
  const { store, rt, adapter, t } = room({ alpha: alpha('Agreed: split, edge for public.'), beta: beta() });
  rt.sendMessage(t.id, { text: '@alpha agree an approach with beta' });
  await settle(rt);
  assert.equal(turnsOf(adapter), 'alpha beta alpha beta alpha');
  assert.equal(replies(store, t).at(-1).wentBack, undefined, 'alpha’s second reply in a row that only wrote');
  // With the @-mention its first line asks for, the discussion goes on.
  const named = room({ alpha: alpha('@beta agreed: split, edge for public.'), beta: beta() });
  named.rt.sendMessage(named.t.id, { text: '@alpha agree an approach with beta' });
  await settle(named.rt);
  assert.ok(heard(named.adapter, 'beta', 'agreed: split, edge for public.'), turnsOf(named.adapter));
});

test('#1591: reading the room through a tool that shows as a step is no more work than reading it through one that doesn’t', async () => {
  // list_assets shows as a step and read_conversation doesn’t (tool-labels.mjs, QUIET): a display choice, which made a
  // turn that listed assets, then wrote “nothing to add”, count as one that did work, however often.
  const looks = (text) => ({ text, reads: true });
  const plays = {
    alpha: [{ text: '@beta the plan is at v2.' }, looks('Nothing to add.'), looks('Still nothing to add.')],
    beta: [{ text: 'Acknowledged.' }, looks('Nothing from me either.')],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha tell beta where the plan is' });
  await settle(rt);
  assert.equal(turnsOf(adapter), 'alpha beta alpha beta alpha');
  assert.equal(replies(store, t).at(-1).wentBack, undefined);
});

test('#1591: a turn that showed a block through a tool call in Postbox’s own process did work, so its reply goes back', async () => {
  // The mock backend calls Postbox’s tools directly, where MCP’s and a host’s calls are noted as they return.
  const pick = {
    type: 'choice',
    version: 1,
    title: 'Pick',
    fallback: 'Pick one',
    prompt: 'Which?',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  };
  const plays = {
    alpha: [{ text: '@beta which layout?' }, { text: 'Two options, then.' }, { text: 'Here they are.', shows: pick }, { text: '' }],
    beta: [{ text: 'Either works.' }, { text: 'Show me both.' }, { text: 'The second.' }],
  };
  const { store, rt, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha agree a layout with beta' });
  await settle(rt);
  const went = Object.fromEntries(replies(store, t).map((i) => [i.text, i.wentBack]));
  assert.ok(
    store.items(t.id).some((i) => i.kind === 'block'),
    'the block is shown',
  );
  assert.deepEqual(went['Here they are.'], ['beta'], 'alpha’s second reply in a row after a reply came back, but not one that only wrote');
});

test('#1591: a turn that acted through one of Postbox’s tools did work, and one that only reacted or read didn’t', () => {
  // Postbox’s own tools show as what they make, not as steps (tool-labels.mjs, QUIET), so the turn keeps a mark.
  const back = { source: 'mention', from: 'alpha', bounce: true };
  const woken = () => ({ asked: { message: { entries: [back] } }, steps: [] });
  const shown = woken();
  noteAnswer(shown, 'update_block', { ok: true });
  assert.equal(endedExchange(shown), false, 'a block it changed is work to report');
  const reacted = woken();
  noteAnswer(reacted, 'react', { ok: true });
  assert.equal(endedExchange(reacted), true, 'a reaction adds nothing to answer');
  const read = woken();
  noteAnswer(read, 'read_conversation', { ok: true });
  assert.equal(endedExchange(read), true, 'nor does reading');
  const refused = woken();
  noteAnswer(refused, 'update_block', { ok: false });
  assert.equal(endedExchange(refused), true, 'nor a call that was refused');
});
