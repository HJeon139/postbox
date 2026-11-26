// #1591: a request is always answered, whatever the turn reacted to. The first version of PR #1759 let a reaction end
// an exchange after any @-mention when the turn did no work, which cut real answers written in the same turn as a 👍
// on the request (the integrator’s review, whose probes these are): a standup’s three statuses never reached the
// coordinator, and the room stopped with nothing waiting. The owner had seen that stall when a scrum-master ran a
// standup. A reaction ends an exchange only on a reply: one that came back on its own, or one in words alone, by
// name, from a turn this agent’s messages alone woke. The player is tests/bounce-loop-fixture.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldOnCard, room, settle } from './bounce-loop-fixture.mjs';

const END = { text: '' };
const turnsOf = (adapter) => adapter.calls.map((c) => c.handle).join(' ');
const heard = (adapter, handle, text) => adapter.calls.some((c) => c.handle === handle && c.text.includes(text));

const STATUS = { alpha: 'parser done, tests pass.', beta: 'blocked on the schema; can you decide v1 or v2?', gamma: 'halfway through the importer.' };
for (const react of [true, false])
  for (const named of [false, true])
    for (const busyMs of [0, 30]) {
      const how = `${react ? 'a 👍 on the ask, then' : 'no reaction,'} a status that names ${named ? '@lead' : 'no one'}${busyMs ? ', after 30 ms' : ''}`;
      test(`#1591: a standup’s three statuses reach the coordinator: ${how}`, async () => {
        const status = (h) => ({ text: `${named ? '@lead ' : ''}${h}: ${STATUS[h]}`, react, busyMs });
        const plays = {
          lead: [
            { text: '@alpha @beta @gamma standup: what’s your status, and are you blocked?' },
            { text: 'Thanks. beta: use v2.' },
            { text: 'Standup closed.' },
            END,
          ],
          alpha: [status('alpha'), END],
          beta: [status('beta'), END],
          gamma: [status('gamma'), END],
        };
        const { store, rt, adapter, t } = room(plays);
        rt.sendMessage(t.id, { text: '@lead run a standup' });
        await settle(rt);
        for (const h of ['alpha', 'beta', 'gamma']) assert.ok(heard(adapter, 'lead', `${h}: ${STATUS[h]}`), `lead heard ${h}: ${turnsOf(adapter)}`);
        assert.ok(!heldOnCard(store, t));
      });
    }

/** The answers the review found cut: each `reaches` is an agent and the words it must be given. */
const ANSWERS = [
  {
    name: '“👍 yes, ship it.” to “can I ship?”, naming no one',
    ask: '@developer ask critic whether you can ship',
    plays: { developer: [{ text: '@critic can I ship?' }, { text: 'Shipping.' }, END], critic: [{ text: '👍 yes, ship it.', react: true }, END] },
    reaches: ['developer', 'yes, ship it.'],
  },
  {
    name: 'the same, by name',
    ask: '@developer ask critic whether you can ship',
    plays: { developer: [{ text: '@critic can I ship?' }, { text: 'Shipping.' }, END], critic: [{ text: '@developer 👍 yes, ship it.', react: true }, END] },
    reaches: ['developer', 'yes, ship it.'],
  },
  {
    name: 'the same, after the asker did work',
    ask: '@developer ask critic whether you can ship',
    plays: {
      developer: [{ text: 'Tests pass. @critic can I ship?', step: true }, { text: 'Shipping.' }, END],
      critic: [{ text: '@developer 👍 yes, ship it.', react: true }, END],
    },
    reaches: ['developer', 'yes, ship it.'],
  },
  {
    name: 'a question from a turn that did work, which only the answering agent’s review woke',
    ask: '@critic review developer’s change',
    plays: {
      critic: [{ text: '@developer two problems: tabs and empty files.', step: true }, { text: '👍 yes, ship it.', react: true }, END],
      developer: [{ text: '@critic fixed both. Can I ship?', step: true }, { text: 'Shipping.' }, END],
    },
    reaches: ['developer', 'yes, ship it.'],
  },
  {
    name: 'a reaction, then a request to the same agent in words',
    ask: '@alpha ask critic for a review',
    plays: {
      alpha: [{ text: '@critic please review wordcount.py.' }, { text: 'README checked: fine.' }, END],
      critic: [{ text: '✅ and @alpha please also check the README.', react: true }, END],
    },
    reaches: ['alpha', 'please also check the README'],
  },
  {
    name: 'a 👍, a read with one of Postbox’s tools, then the review (assets-room, turn 4)',
    ask: '@researcher write a plan and have critic review it',
    plays: {
      researcher: [{ text: 'I wrote the plan to notes/plan.md, where @critic can read it.' }, { text: 'Revised bullet 2.' }, END],
      critic: [{ text: 'I reviewed notes/plan.md. Bullet 2 contradicts itself; bullet 5 is too broad to act on.', react: true, reads: true }, END],
    },
    reaches: ['researcher', 'Bullet 2 contradicts itself'],
  },
];
for (const { name, ask, plays, reaches } of ANSWERS) {
  test(`#1591: an answer written after a reaction to the request reaches the agent that asked: ${name}`, async () => {
    const { rt, adapter, t } = room(plays);
    rt.sendMessage(t.id, { text: ask });
    await settle(rt);
    assert.ok(heard(adapter, ...reaches), `${reaches[0]} heard it: ${turnsOf(adapter)}`);
  });
}
