// #1591, the owner’s ruling of 26 November 2026, on PR #1823: “A @mention always wakes. no matter what rule”. No rule
// that ends an exchange may hold a wake an @-mention asks for. Postbox held one: the name of an agent whose reply the
// turn had reacted to (#1724). Counts of turns without work, tried on that PR, held others, and each stalled a room
// whose coordinator, who never does work, named a worker; those rooms are played here too. Agents that go on naming
// each other are bounded by the room’s chain limit alone. The player is tests/bounce-loop-fixture.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldOnCard, LIMIT, room, settle } from './bounce-loop-fixture.mjs';

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

for (const [what, plays, words] of [
  [
    'a standup whose first status is acknowledged',
    {
      lead: [{ text: '@alpha @beta standup: status?' }, { text: 'Thanks, waiting for beta.' }, { text: 'Noted.' }, { text: '@alpha take the importer.' }, END],
      alpha: [{ text: 'alpha: parser done, nothing blocked.' }, { text: 'OK, standing by.' }, WORK, END],
      beta: [{ text: 'beta: exporter done.', busyMs: 150 }, END],
    },
    'take the importer',
  ],
  [
    'an instruction by name as the fourth turn without work',
    {
      lead: [{ text: '@alpha status?' }, { text: 'Thanks. Which story do you want next?' }, { text: '@alpha take the importer.' }, END],
      alpha: [{ text: 'parser done.' }, { text: 'The importer.' }, WORK, END],
    },
    'take the importer',
  ],
  [
    'a hand-off by name after three courtesy replies',
    {
      lead: [{ text: '@alpha the parser is in.', step: true }, { text: 'You are welcome.' }, { text: '@alpha please review parser.py.' }, END],
      alpha: [{ text: 'Thanks!' }, { text: 'Great.' }, WORK, END],
    },
    'please review parser.py',
  ],
  [
    'an assignment after the other agent ended a turn without writing',
    {
      lead: [{ text: '@alpha @beta standup: status?' }, { text: 'Thanks alpha.' }, { text: '@alpha take the importer. @beta write its tests.' }, END],
      alpha: [{ text: 'alpha: parser done.' }, END, WORK, END],
      beta: [{ text: 'beta: exporter done.', busyMs: 400 }, WORK, END],
    },
    'take the importer',
  ],
  [
    'an instruction by name long after the fourth turn without work',
    {
      lead: [{ text: '@alpha status?' }, { text: '@alpha and the tests?' }, { text: '@alpha and the docs?' }, { text: '@alpha take the importer.' }, END],
      alpha: [{ text: '@lead parser done.' }, { text: '@lead they pass.' }, { text: '@lead written.' }, WORK, END],
    },
    'take the importer',
  ],
  [
    // The one Postbox held (#1724): a reaction to the reply that came back, then a name in the same turn.
    'a name in a turn that reacted to the reply that came back',
    {
      lead: [{ text: '@alpha status?' }, { text: '@alpha take the importer.', react: true }, END],
      alpha: [{ text: 'parser done.' }, WORK, END],
    },
    'take the importer',
  ],
]) {
  test(`#1591 mentions: ${what} wakes the agent it names`, async () => {
    const { adapter } = await play(plays, '@lead go');
    assert.ok(heard(adapter, 'alpha', words), turnsOf(adapter));
  });
}

test('#1591 mentions: agents that go on naming each other in words are bounded by the chain limit alone', async () => {
  const { store, adapter, t } = await play({ alpha: [{ text: 'Noted @beta.' }], beta: [{ text: 'Noted @alpha.' }] }, '@alpha start');
  assert.ok(heldOnCard(store, t), turnsOf(adapter));
  assert.equal(adapter.calls.length, LIMIT + 1, 'every name woke its agent, up to the limit');
});
