// PROTOTYPE, not for merge (#1591, the count rule): an exchange between two agents ends when K turns in a row between
// that pair did no work (K = 4). A turn that did work, or that the person woke, restarts the count. Reactions, direct
// @-mentions and replies going back are all just turns. The player is tests/bounce-loop-fixture.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldOnCard, playsWoken, room, settle } from './bounce-loop-fixture.mjs';

const END = { text: '' };
const WORK = { text: 'Did it: committed.', step: true };
const turnsOf = (adapter) => adapter.calls.map((c) => c.handle).join(' ');
const heard = (adapter, handle, text) => adapter.calls.some((c) => c.handle === handle && c.text.includes(text));
async function play(plays, ask) {
  const r = room(plays);
  r.rt.sendMessage(r.t.id, { text: ask });
  await settle(r.rt);
  return r;
}

for (const react of [true, false])
  for (const named of [true, false])
    test(`count: a standup’s statuses and the next instruction are delivered (${react ? '👍 on each' : 'no reaction'}, statuses name ${named ? '@lead' : 'no one'})`, async () => {
      const status = (h) => ({ text: `${named ? '@lead ' : ''}${h}: done with my part.`, react });
      const { adapter } = await play(
        {
          lead: [{ text: '@alpha @beta standup: status?' }, { text: '@alpha start the importer.', react }, { text: '@beta write its tests.', react }, END],
          alpha: [status('alpha'), WORK, END],
          beta: [status('beta'), WORK, END],
        },
        '@lead run a standup',
      );
      for (const h of ['alpha', 'beta']) assert.ok(heard(adapter, 'lead', `${h}: done with my part.`), `lead heard ${h}: ${turnsOf(adapter)}`);
      assert.ok(heard(adapter, 'alpha', 'start the importer') || heard(adapter, 'beta', 'write its tests'), `an instruction was heard: ${turnsOf(adapter)}`);
    });

test('count: a second instruction in words after the agent’s work is heard, since work restarts the count', async () => {
  const { adapter } = await play(
    {
      lead: [{ text: '@alpha status?' }, { text: 'Thanks. Next: start the importer.' }, { text: 'Good. Now write its tests.' }, END],
      alpha: [{ text: 'parser done.' }, WORK, WORK, END],
    },
    '@lead ask alpha',
  );
  assert.ok(heard(adapter, 'alpha', 'Now write its tests.'), turnsOf(adapter));
});

test('count: a 👍 on a request, then the answer in words, is heard', async () => {
  const { adapter } = await play(
    { developer: [{ text: '@critic can I ship?' }, END], critic: [{ text: '👍 yes, ship it.', react: true }, END] },
    '@developer ask critic',
  );
  assert.ok(heard(adapter, 'developer', 'yes, ship it.'), turnsOf(adapter));
});

test('count: closing lines stop after four turns with no work, with or without reactions', async () => {
  for (const react of [true, false]) {
    const line = (who) => ({ text: `The exchange with @${who} is closed.`, react });
    const { store, adapter, t } = await play(
      { alpha: [{ text: '@critic done on my side.', step: true }, line('critic')], critic: [line('alpha')] },
      '@alpha tell critic',
    );
    assert.ok(!heldOnCard(store, t), turnsOf(adapter));
    assert.equal(adapter.calls.length, 5, `the work turn, then four closing turns: ${turnsOf(adapter)}`);
  }
});

test('count: a ring of three that only writes ends, and a ring at work goes on', async () => {
  const ring = (next, more = {}) => [{ text: `@${next} over to you.`, react: true, ...more }];
  const idle = await play({ alpha: ring('beta'), beta: ring('gamma'), gamma: ring('alpha') }, '@alpha start');
  assert.ok(!heldOnCard(idle.store, idle.t), turnsOf(idle.adapter));
  const busy = await play({ alpha: ring('beta', { step: true }), beta: ring('gamma', { step: true }), gamma: ring('alpha', { step: true }) }, '@alpha start');
  assert.ok(heldOnCard(busy.store, busy.t), 'only the chain limit ends a ring that does work each turn');
});

for (const [run, critic, developer, to] of [
  ['pairwork', 12, 14, 27],
  ['pairwork', 29, 30, 36],
  ['pairwork-2', 8, 10, 17],
  ['pairwork-2', 19, 20, 22],
])
  test(`count: the recorded loop ends within four closing turns (${run}, from turn ${critic})`, async () => {
    const plays = { critic: [...playsWoken(run, 'critic', critic, to), END], developer: [...playsWoken(run, 'developer', developer, to), END] };
    const { store, adapter, t } = await play(plays, '@critic check developer’s fixes');
    assert.ok(!heldOnCard(store, t));
    assert.ok(adapter.calls.length - 1 <= 4, `${adapter.calls.length - 1} closing turns: ${turnsOf(adapter)}`);
  });
