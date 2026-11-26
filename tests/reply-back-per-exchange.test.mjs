// #1591, the count of “second in a row” belongs to an exchange, not to an agent across everyone it talks to (round 2
// of the review of PR #1724). In a room of three agents, an agent’s first reply in words to one agent was cut when its
// last reply in words had gone to another. The player is tests/bounce-loop-fixture.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnInput } from '../server/turn-input.mjs';
import { heldOnCard, room, settle } from './bounce-loop-fixture.mjs';

const work = (text, more = {}) => ({ text, step: true, ...more });
const END = { text: '' };
const replies = (store, t) => store.items(t.id).filter((i) => i.kind === 'agent' && i.text?.trim());
const heard = (adapter, handle, text) => adapter.calls.some((c) => c.handle === handle && c.text.includes(text));
const turnsOf = (adapter) => adapter.calls.map((c) => c.handle).join(' ');

test('#1591: a lead answers two agents’ clarifying questions in words, one after the other, and both hear', async () => {
  const plays = {
    alpha: [{ text: '@beta add the changelog entry. @gamma add the test.' }, { text: 'Under Unreleased.' }, { text: 'In tests/unit.' }, END],
    beta: [{ text: 'Which section does it go under?' }, work('')],
    // gamma is slower, so alpha answers beta first, in a turn of its own.
    gamma: [{ text: 'Which folder do the tests live in?', busyMs: 40 }, work('Added the test in tests/unit.')],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha have beta and gamma finish the release' });
  await settle(rt);
  assert.ok(heard(adapter, 'beta', 'Under Unreleased.'), turnsOf(adapter));
  assert.ok(heard(adapter, 'gamma', 'In tests/unit.'), `gamma heard its answer: ${turnsOf(adapter)}`);
  const said = Object.fromEntries(replies(store, t).map((i) => [i.text, i.wentBack]));
  assert.deepEqual(said['In tests/unit.'], ['gamma']);
  // alpha’s first line for that turn promises what happens: its last reply in words went to beta, not to gamma.
  const third = adapter.calls.filter((c) => c.handle === 'alpha')[2].text;
  assert.match(third, /Your reply posts there and goes back to @gamma\. /);
  assert.doesNotMatch(third, /only wrote/);
});

test('#1591: a reviewer approves two authors’ fixes in words, one after the other, and both hear', async () => {
  const plays = {
    critic: [
      work('@dev1 tabs count as words. @dev2 an empty file prints nothing.'),
      { text: 'Looks good, ship it.' },
      { text: 'That one holds too, ship it.' },
      END,
    ],
    dev1: [work('Fixed the tabs case.'), work('')],
    dev2: [work('Fixed the empty file case.', { busyMs: 40 }), work('Shipped mine.')],
  };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@critic review both' });
  await settle(rt);
  assert.ok(heard(adapter, 'dev1', 'Looks good, ship it.'), turnsOf(adapter));
  assert.ok(heard(adapter, 'dev2', 'That one holds too, ship it.'), `dev2 heard the approval: ${turnsOf(adapter)}`);
});

test('#1591: an exchange that ended stays ended: the third reply in a row that only writes wakes no one either', async () => {
  // One agent thanks two, and each answers. A reply that went back to no one used to carry no mark, so it broke the
  // run, and alpha’s third thanks went back again.
  const plays = {
    alpha: [{ text: '@beta @gamma the plan is at v2.' }, { text: 'Thanks both.' }, { text: 'Thanks again.' }, { text: 'And again.' }],
    beta: [{ text: 'Seen.' }, { text: 'Welcome.' }, { text: 'Sure.' }],
    gamma: [{ text: 'Seen too.' }, { text: 'Any time.' }, { text: 'OK.' }],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha tell beta and gamma' });
  await settle(rt);
  assert.ok(!heldOnCard(store, t), turnsOf(adapter));
  const mine = replies(store, t).filter((i) => i.handle === 'alpha');
  const cut = mine.filter((i) => i.wordsOnly && !i.wentBack);
  assert.ok(cut.length >= 1, 'alpha’s second reply in words to each went to no one');
  // After the first reply that went to no one, none of alpha’s replies goes back to anyone: both exchanges have ended.
  for (const it of mine.slice(mine.indexOf(cut[0]))) assert.equal(it.wentBack, undefined, `${it.text} went back`);
  assert.ok(!adapter.calls.some((c) => c.handle !== 'alpha' && c.text.includes('And again.')), 'no one was woken by the third');
});

test('#1591: three agents, each pair exchanging lines that only write, still end', async () => {
  const plays = {
    alpha: [{ text: '@beta @gamma the plan is at v2.' }, { text: 'Thanks.' }],
    beta: [{ text: '@gamma seen; you?' }, { text: 'Noted.' }],
    gamma: [{ text: '@alpha seen. And beta?', busyMs: 15 }, { text: 'OK.' }],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha tell beta and gamma' });
  await settle(rt);
  assert.ok(!heldOnCard(store, t), `ended before the room’s limit: ${turnsOf(adapter)}`);
  assert.ok(adapter.calls.length <= 16, `${adapter.calls.length} turns: ${turnsOf(adapter)}`);
});

test('#1591: work, then words to the same agent, starts that exchange’s count again', async () => {
  const plays = {
    alpha: [
      { text: '@beta draft the plan.' },
      { text: 'Add a rollback step.' },
      work('I checked the runbook: one gap.'),
      { text: 'Good, that closes it.' },
      END,
    ],
    beta: [work('Drafted the plan.'), work('Added the rollback step.'), work('Closed the gap.'), work('Filed it.')],
  };
  const { store, rt, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha have beta draft the plan' });
  await settle(rt);
  const said = Object.fromEntries(replies(store, t).map((i) => [i.text, i.wentBack]));
  assert.deepEqual(said['Good, that closes it.'], ['beta']);
});

test('#1591: a turn that starts as the agent’s last one ends is told whom its reply won’t go back to', async () => {
  // Round 3 of the review of PR #1724: gamma’s and beta’s replies waited while alpha wrote its thanks to delta, so
  // alpha’s next turn started as that one ended, and its first line was built before the thanks was marked.
  const plays = {
    alpha: [
      { text: '@beta which file? @gamma which test? @delta which doc?' },
      { text: 'Which section?' },
      { text: 'Thanks delta.', busyMs: 90 },
      { text: 'Both clear.' },
      END,
    ],
    beta: [{ text: 'CHANGELOG.md.' }, { text: 'Under Unreleased.', busyMs: 20 }, END],
    gamma: [{ text: 'tests/unit.', busyMs: 45 }, work('')],
    delta: [{ text: 'README.', busyMs: 10 }, END],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask all' });
  await settle(rt);
  const line = adapter.calls.filter((c) => c.handle === 'alpha')[3].text.split('\n')[0];
  assert.deepEqual(replies(store, t).find((i) => i.text === 'Both clear.')?.wentBack, ['gamma']);
  assert.match(line, /goes back to @gamma\. .*Your last reply to @beta only wrote/);
});

test('#1591: a reply that only wrote, which the chain limit holds, is marked for the agent it waits to reach', async () => {
  const plays = { alpha: [{ text: '@beta which file?' }, { text: 'Which section?' }], beta: [{ text: 'CHANGELOG.md.' }] };
  const { store, rt, t } = room(plays);
  rt.threads.patch(t.id, { chainLimit: 2 });
  rt.sendMessage(t.id, { text: '@alpha ask beta' });
  await settle(rt);
  assert.ok(heldOnCard(store, t), 'the third wake in the chain waits on the card');
  const held = replies(store, t).find((i) => i.text === 'Which section?');
  assert.deepEqual([held.wordsOnly, held.wentBack], [['beta'], undefined]);
});

const read = () => 'A reply.';
const back = (from, n) => ({ id: `en_${n}`, threadId: 'th_1', itemId: `it_${n}`, source: 'mention', from, at: 0, bounce: true });
const firstLine = (entries, wroteOnly) => turnInput({ entries, thread: { id: 'th_1', kind: 'room' }, read, wroteOnly }).split('\n')[0];

test('#1591: the first line says which agent a reply that only writes won’t go back to, and which it will', () => {
  const both = [back('beta', 1), back('gamma', 2)];
  const mixed = firstLine(both, ['beta']);
  assert.match(mixed, /Your reply posts there and goes back to @gamma\. @-mention another agent to hand off to them instead\. /);
  assert.match(
    mixed,
    /Your last reply to @beta only wrote, so this one goes back to @beta only if you do work this turn \(more than reading the room and reacting\): /,
  );
  assert.match(
    mixed,
    /a second in a row to the same agent that only writes doesn’t wake it, so @-mention whoever must act on it or answer it\. If the exchange is done, /,
  );
  const all = firstLine(both, ['beta', 'gamma']);
  assert.match(
    all,
    /Your reply posts there\. Your last reply to @beta and @gamma only wrote, so this one goes back to @beta and @gamma only if you do work this turn /,
  );
  const none = firstLine(both, ['delta']);
  assert.match(
    none,
    /Your reply posts there and goes back to @beta and @gamma\. @-mention another agent to hand off to them instead\. If the exchange is done, /,
  );
  assert.doesNotMatch(none, /only wrote/);
});

test('#1591: a turn a direct @-mention woke isn’t told its last reply only wrote', () => {
  const asked = { ...back('beta', 1), bounce: false };
  assert.doesNotMatch(firstLine([asked], ['beta']), /only wrote/);
  assert.doesNotMatch(firstLine([asked, back('beta', 2)], ['beta']), /only wrote/);
});
