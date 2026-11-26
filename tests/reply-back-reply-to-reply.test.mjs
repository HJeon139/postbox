// PROTOTYPE, not for merge (#1591, “end only on a reply to a reply”): a reaction ends an exchange on a reply by name
// only when that reply itself answered a reply. A message in words that names the agent whose request woke its turn is
// an answer, not a reply, so a reaction to it ends nothing. The player is tests/bounce-loop-fixture.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldOnCard, playsWoken, room, settle } from './bounce-loop-fixture.mjs';

const END = { text: '' };
const turnsOf = (adapter) => adapter.calls.map((c) => c.handle).join(' ');
const heard = (adapter, handle, text) => adapter.calls.some((c) => c.handle === handle && c.text.includes(text));
async function play(plays, ask) {
  const r = room(plays);
  r.rt.sendMessage(r.t.id, { text: ask });
  await settle(r.rt);
  return r;
}

test('reply to a reply: a coordinator’s 👍 on a status that names it, then an instruction by name, is heard', async () => {
  const { adapter } = await play(
    {
      lead: [{ text: '@alpha standup: status?' }, { text: '@alpha start the importer.', react: true }, END],
      alpha: [{ text: '@lead alpha: parser done.' }, { text: 'Did it: committed.', step: true }, END],
    },
    '@lead run a standup',
  );
  assert.ok(heard(adapter, 'alpha', 'start the importer'), turnsOf(adapter));
});

test('reply to a reply: a request in words from a turn the other agent woke gets its answer after a reaction', async () => {
  // The recorded shape (pairwork run 1, turns 2, 3 and 5).
  const { adapter } = await play(
    {
      critic: [{ text: 'This request is for @developer. I’ll wait for the code.' }, { text: 'Reviewed: one change needed, map ß to ss.', react: true }, END],
      developer: [{ text: '@critic the code is in the workspace. Please review those two files.' }, { text: 'Mapped ß to ss.', step: true }, END],
    },
    '@critic review what developer wrote',
  );
  assert.ok(heard(adapter, 'developer', 'one change needed'), turnsOf(adapter));
});

test('reply to a reply: closing lines still end on a reaction, one exchange later', async () => {
  const line = (who) => ({ text: `I reacted ✅ to @${who}’s message; nothing is left.`, react: true });
  const { store, adapter, t } = await play(
    { alpha: [{ text: '@critic done on my side.', step: true }, line('critic')], critic: [line('alpha')] },
    '@alpha tell critic',
  );
  assert.ok(!heldOnCard(store, t), turnsOf(adapter));
  assert.ok(adapter.calls.length <= 5, turnsOf(adapter));
});

for (const [run, critic, developer, to, most] of [
  ['pairwork', 12, 14, 27, 3],
  ['pairwork', 29, 30, 36, 3],
  ['pairwork-2', 8, 10, 17, 5],
  ['pairwork-2', 19, 20, 22, 3],
])
  test(`reply to a reply: the recorded loop ends within ${most} closing turns (${run}, from turn ${critic})`, async () => {
    const plays = { critic: [...playsWoken(run, 'critic', critic, to), END], developer: [...playsWoken(run, 'developer', developer, to), END] };
    const { store, adapter, t } = await play(plays, '@critic check developer’s fixes');
    assert.ok(!heldOnCard(store, t));
    assert.ok(adapter.calls.length - 1 <= most, `${adapter.calls.length - 1} closing turns: ${turnsOf(adapter)}`);
  });
