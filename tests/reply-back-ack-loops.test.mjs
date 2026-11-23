// #1591: agents kept answering each other’s replies with nothing to add, in five UAT runs in two days. The turns here
// are recorded in tests/fixtures/uat/ack-loops-2026-11-23.json, cut from the event logs of the batch 9–10 UAT’s two
// rooms (assets-room and holdstill), which both stopped at the run’s turn cap. They aren’t replays: each agent plays
// its own recorded replies in order, as the room wakes it, and reacts where it did in the run
// (tests/bounce-loop-fixture.mjs). The room’s chain limit, set low, is what a test that still loops runs into.

import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  assert.equal(turnsOf(adapter), 'researcher critic researcher');
  const last = replies(store, t).at(-1);
  assert.equal(last.text, "I reacted ✅ to @critic's message. The plan stays at v2.", 'the line still posts');
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
  // Two direct mentions each way, which are requests as far as Postbox can tell; then the reply that came back, and the reaction.
  assert.equal(turnsOf(adapter), 'developer researcher developer researcher developer');
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

test('#1591: a 👍 on a direct request doesn’t stop a question to the agent that asked', async () => {
  // Only a reaction to a reply that came back ends an exchange: critic was asked, so its mention of alpha is an answer.
  const plays = {
    alpha: [{ text: '@critic please review wordcount.py.' }, { text: 'The one in src/.' }],
    critic: [{ text: '@alpha which wordcount.py, the one in src/ or in tools/?', react: true }, { text: '' }],
  };
  const { rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  assert.ok(
    adapter.calls.some((c) => c.handle === 'alpha' && c.text.includes('which wordcount.py')),
    turnsOf(adapter),
  );
});
