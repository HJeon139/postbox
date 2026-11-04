// #693: once the person declines adding an agent to a conversation, a prose @-mention of it there raises no new card,
// and its sender is told. On 2 November a third card for the same agent, raised 36 s after the second decline, held the
// room's wakes for hours. wake_agent stays a deliberate ask, and raises a card.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

const addCards = (f) => f.store.items(f.t.id).filter((i) => i.kind === 'hop' && i.join);
const notices = (f, se) => f.adapter.calls.filter((c) => c.sessionId === se.id).map((c) => c.message?.text ?? '');

/** An agent's turn, as the person asks it, that says `said` in prose. */
async function says(f, se, said) {
  f.adapter.next.push(async (c) => c.text(said));
  f.rt.sendMessage(f.t.id, { text: `@${se.handle} go on` });
  await settle(f.rt);
}

/** @alpha mentions @gamma, which the conversation doesn't have, and the person declines adding it. */
async function declined() {
  const f = setup();
  await says(f, f.alpha, 'Let’s ask @gamma to check the numbers.');
  const [card] = addCards(f);
  assert.equal(card?.status, 'open', 'the first mention asks the person');
  f.rt.resolveHop(f.t.id, card.id, false);
  await settle(f.rt);
  return { ...f, card };
}

test('#693 after the person declines adding an agent, a prose mention of it raises no new card, and its sender is told', async () => {
  const f = await declined();
  await says(f, f.beta, 'Then @gamma can take a look later.');
  assert.equal(addCards(f).length, 1, 'no second card');
  assert.equal(f.store.state.sessions[f.beta.id].needs, null, 'beta doesn’t need the person');
  const told = (f.store.state.sessions[f.beta.id].context ?? []).join(' | ');
  assert.match(told, /Your mention of @gamma woke no one: the person chose not to add @gamma to this conversation/, told);
});

test('#693 the decline holds after a restart, since the card is in the store', async () => {
  const f = await declined();
  const { Runtime } = await import('../server/runtime.mjs');
  const rt = new Runtime({ store: f.store, adapters: f.rt.adapters, corpus: f.rt.corpus, config: f.rt.config });
  const r = rt.agentWake(f.beta.id, 'gamma', 'From a mention.', { itemId: 'it_x', prose: true });
  assert.equal(r.ok, false);
  assert.equal(r.waiting, undefined, 'not held, and no card');
  assert.equal(addCards(f).length, 1);
});

test('#693 wake_agent for a declined agent still asks the person: it’s a deliberate ask', async () => {
  const f = await declined();
  const r = f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'I really need gamma for this.' });
  assert.equal(r.waiting, true);
  assert.equal(addCards(f).length, 2, 'a new card');
});

test('#693 a decline in one conversation doesn’t stop a mention in another', async () => {
  const f = await declined();
  const t2 = f.rt.createThread({ projectId: 'p1', title: 'T2', personaIds: [f.a.id] });
  const [alpha2] = f.rt.sessionsIn(t2.id);
  const r = f.rt.agentWake(alpha2.id, 'gamma', 'Over here.', { itemId: 'it_y', prose: true });
  assert.equal(r.waiting, true, 'asks the person in the other conversation');
});

test('#693 declining one agent doesn’t stop a prose mention of another the conversation doesn’t have', async () => {
  const f = await declined();
  f.rt.createPersona({ handle: 'delta' });
  const r = f.rt.agentWake(f.beta.id, 'delta', 'And delta?', { itemId: 'it_z', prose: true });
  assert.equal(r.waiting, true, 'asks the person to add delta');
});

test('#693 the issue’s acceptance, which passes on main too: declining a card tells the sender of a mention held on it', async () => {
  const f = setup();
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'Check the numbers.' });
  const [card] = addCards(f);
  await says(f, f.beta, 'And @gamma, the totals too.');
  assert.equal(f.store.item(f.t.id, card.id).held?.length, 1, 'beta’s mention is held on alpha’s card');
  f.rt.resolveHop(f.t.id, card.id, false);
  await settle(f.rt);
  const told = notices(f, f.beta).join(' | ');
  assert.match(told, /so your message held on it .* didn’t go to @gamma/, told);
});
