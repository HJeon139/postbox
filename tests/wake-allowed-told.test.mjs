// #517: when the person allowed a wake card, the wakes it held went, but no agent was told. Only a decline said so.
// Agents went on telling the person their messages were “still waiting for your approval”, and asked again. Allowing
// the card now leaves each agent whose message went a note for its next turn: a note, not a wake, so it starts no turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** @alpha’s wake of @beta past the room’s chain limit, 3 here, waits on a card, and @gamma’s wake of @alpha is held on it. */
async function heldOnCard() {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.handle === 'gamma');
  arrange.setThread(f.rt, f.t.id, { chainLimit: 3 });
  for (let i = 0; i < 3; i++) f.rt.agentWake(...(i % 2 ? [f.beta.id, 'alpha'] : [f.alpha.id, 'beta']), `hand-off ${i + 1}`);
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'alpha to beta').waiting, true, 'the card is up');
  await settle(f.rt);
  assert.equal(f.rt.agentWake(gamma.id, 'alpha', 'Count the lines.').waiting, true, 'gamma’s wake is held on it');
  await settle(f.rt);
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  return { ...f, gamma, card };
}

/** Who the card carries: the agent that asked for it, and each agent whose message it held, with whom each went to. */
const carried = (f) => [{ id: f.card.fromSessionId, to: f.card.to }, ...(f.card.held ?? []).map((w) => ({ id: w.fromSessionId, to: w.to }))];
/** What an agent was told: notes still waiting for its next turn, and those its turns since were given. */
const notesOf = (f, id) => [
  ...(f.store.state.sessions[id].context ?? []),
  ...f.adapter.calls.filter((c) => c.sessionId === id).map((c) => JSON.stringify(c.message)),
];

test('#517: allowing a wake card tells the agent that asked, and each agent whose message it held, that it went', async () => {
  const f = await heldOnCard();
  const who = carried(f);
  assert.ok(who.length >= 2, 'the card holds another agent’s message');
  f.rt.resolveHop(f.t.id, f.card.id, true);
  await settle(f.rt);
  for (const { id, to } of who)
    assert.ok(
      notesOf(f, id).some((n) => n.includes(`went to @${to}`)),
      `${f.store.state.sessions[id].handle}: ${notesOf(f, id).join(' | ')}`,
    );
});

test('#517: declining tells them as before, and says nothing went', async () => {
  const f = await heldOnCard();
  const who = carried(f);
  f.rt.resolveHop(f.t.id, f.card.id, false);
  await settle(f.rt);
  for (const { id } of who) assert.ok(!notesOf(f, id).some((n) => n.includes('went to @')));
});

test('#517: allowing a card with nothing held on it tells the agent that asked', async () => {
  const f = setup();
  arrange.setThread(f.rt, f.t.id, { chainLimit: 3 });
  for (let i = 0; i < 3; i++) f.rt.agentWake(...(i % 2 ? [f.beta.id, 'alpha'] : [f.alpha.id, 'beta']), `hand-off ${i + 1}`);
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'alpha to beta').waiting, true);
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  assert.deepEqual(card.held ?? [], [], 'nothing else waits on it');
  f.rt.resolveHop(f.t.id, card.id, true);
  await settle(f.rt);
  assert.ok(
    notesOf(f, card.fromSessionId).some((n) => n.includes(`went to @${card.to}`)),
    notesOf(f, card.fromSessionId).join(' | '),
  );
});

test('#517: the note starts no turn of its own', async () => {
  const f = setup();
  arrange.setThread(f.rt, f.t.id, { chainLimit: 3 });
  for (let i = 0; i < 3; i++) f.rt.agentWake(...(i % 2 ? [f.beta.id, 'alpha'] : [f.alpha.id, 'beta']), `hand-off ${i + 1}`);
  f.rt.agentWake(f.alpha.id, 'beta', 'alpha to beta');
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  await settle(f.rt);
  const before = f.adapter.calls.filter((c) => c.sessionId === card.fromSessionId).length;
  f.rt.resolveHop(f.t.id, card.id, true);
  await settle(f.rt);
  // Its agent has a turn only if the allowed wake’s answer goes back to it (#1518), never for the note alone.
  const after = f.adapter.calls.filter((c) => c.sessionId === card.fromSessionId);
  for (const c of after.slice(before)) assert.notEqual(c.message?.kind, 'notice', JSON.stringify(c.message));
  assert.ok(
    (f.store.state.inbox[card.fromSessionId] ?? []).every((e) => e.source !== 'notice'),
    'no entry for it',
  );
});
