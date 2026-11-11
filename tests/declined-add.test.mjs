// #693: once the person declines adding an agent to a conversation, a prose @-mention of it there raises no new card,
// and its sender is told. On 2 November a third card for the same agent, raised 36 s after the second decline, held the
// room's wakes for hours. wake_agent stays a deliberate ask, and raises a card.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

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
  const rt = new Runtime({ store: f.store, adapters: f.rt.adapters, config: f.rt.config });
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

test('#693 a later add the person allowed lifts the decline: once that agent is removed, a mention asks again', async () => {
  const f = await declined();
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'I really need gamma for this.' });
  const second = addCards(f).find((c) => c.status === 'open');
  f.rt.resolveHop(f.t.id, second.id, true);
  await settle(f.rt);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  f.rt.deleteSession(gamma.id);
  f.rt.purgeSession(gamma.id);
  const r = f.rt.agentWake(f.beta.id, 'gamma', 'Back again?', { itemId: 'it_w', prose: true });
  assert.equal(r.waiting, true, 'the person’s latest answer was yes');
});

test('#693 a card retiring forks declined isn’t the person’s decline', async () => {
  const f = setup();
  f.rt.addItem(f.t.id, { kind: 'hop', join: true, fromSessionId: 'se_fork', from: 'alpha', to: 'gamma', text: 'x', status: 'declined' });
  f.store.emit('session', { id: 'se_fork', personaId: f.a.id, handle: 'alpha', threadId: f.t.id, archived: true, retiredFork: true });
  const r = f.rt.agentWake(f.beta.id, 'gamma', 'Over to gamma.', { itemId: 'it_v', prose: true });
  assert.equal(r.waiting, true);
});

test('#693 a mention of a declined agent while another card waits is refused, not held on that card', async () => {
  const f = await declined();
  f.rt.createPersona({ handle: 'delta' });
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'delta', message: 'Chart?' });
  const r = f.rt.agentWake(f.beta.id, 'gamma', 'And gamma.', { itemId: 'it_u', prose: true });
  assert.deepEqual([r.ok, r.held], [false, undefined]);
  assert.match(r.message, /chose not to add @gamma/);
});

test('#693 a declined wake-limit card for an agent isn’t a declined add', async () => {
  const f = setup();
  f.rt.addItem(f.t.id, { kind: 'hop', fromSessionId: f.alpha.id, from: 'alpha', to: 'gamma', text: 'x', status: 'declined', n: 51 });
  const r = f.rt.agentWake(f.beta.id, 'gamma', 'Gamma?', { itemId: 'it_t', prose: true });
  assert.equal(r.waiting, true);
});

test('#693 a card closed because its agent was archived isn’t a decline: a later mention asks the person', async () => {
  const f = setup();
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'Check the numbers.' });
  f.rt.archive(f.alpha.id);
  assert.equal(addCards(f)[0].status, 'closed');
  await says(f, f.beta, 'Then @gamma can take a look.');
  assert.equal(addCards(f).filter((c) => c.status === 'open').length, 1, 'a new card asks');
});

test('#693 a prose mention from a topic thread is refused after a decline in its conversation', async () => {
  const f = await declined();
  const reply = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.handle === 'alpha');
  const topic = f.rt.startTopic(f.t.id, reply.id).threadId;
  f.adapter.next.push(async (c) => c.text('Then @gamma can check it here.'));
  f.rt.sendMessage(topic, { text: '@beta over to you' });
  await settle(f.rt);
  assert.equal(addCards(f).length, 1, 'no second card');
  assert.match((f.store.state.sessions[f.beta.id].context ?? []).join(' | '), /Your mention of @gamma woke no one: the person chose not to add @gamma/);
});

/** The person removes @gamma from the conversation, as the remove menu does: the session goes, and is purged. */
function removeGamma(f) {
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  assert.ok(gamma, '@gamma had joined');
  f.rt.deleteSession(gamma.id);
  f.rt.purgeSession(gamma.id);
}

/** @beta mentions @gamma in prose once it's gone: whether the person is asked. */
const mentionAsks = (f, rt = f.rt) => rt.agentWake(f.beta.id, 'gamma', 'Back again?', { itemId: 'it_w', prose: true }).waiting === true;

test('#789 the person’s own @-mention lifts a decline: once that agent is removed, a mention asks again', async () => {
  const f = await declined();
  f.rt.sendMessage(f.t.id, { text: '@gamma please join' });
  await settle(f.rt);
  removeGamma(f);
  assert.equal(mentionAsks(f), true, 'the person’s latest answer was to add it');
  assert.equal(addCards(f).filter((c) => c.status === 'open').length, 1, 'a card asks the person');
});

test('#789 a mention in a topic thread lifts it too', async () => {
  const f = await declined();
  const reply = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.handle === 'alpha');
  const topic = f.rt.startTopic(f.t.id, reply.id).threadId;
  f.rt.sendMessage(topic, { text: '@gamma please look' });
  await settle(f.rt);
  removeGamma(f);
  assert.equal(mentionAsks(f), true);
});

test('#789 a new agent created into the conversation lifts a decline of its handle', async () => {
  const f = setup();
  // A decline of adding an earlier @delta, whose persona is gone, is in the conversation.
  f.rt.addItem(f.t.id, { kind: 'hop', join: true, fromSessionId: f.alpha.id, from: 'alpha', to: 'delta', text: 'x', status: 'declined' });
  const p = f.rt.createPersona({ handle: 'delta' });
  // What POST /api/personas does with join: { threadId } (server/index.mjs).
  f.rt.ensureSession(f.rt.lineage(f.t.id).at(-1), p.id, { brief: 'You were just created and added to this thread.' });
  const delta = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'delta');
  f.rt.deleteSession(delta.id);
  f.rt.purgeSession(delta.id);
  assert.equal(f.rt.agentWake(f.beta.id, 'delta', 'Delta?', { itemId: 'it_d', prose: true }).waiting, true);
});

test('#789 a decline after the person’s add holds', async () => {
  const f = await declined();
  f.rt.sendMessage(f.t.id, { text: '@gamma please join' });
  await settle(f.rt);
  removeGamma(f);
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'I need gamma again.' });
  const again = addCards(f).find((c) => c.status === 'open');
  f.rt.resolveHop(f.t.id, again.id, false);
  await settle(f.rt);
  assert.equal(mentionAsks(f), false, 'the newest answer is the decline');
  assert.equal(addCards(f).filter((c) => c.status === 'open').length, 0, 'no card');
});

test('#789 adding an agent whose handle starts another’s doesn’t lift that one’s decline', async () => {
  const f = await declined();
  f.rt.createPersona({ handle: 'gam' });
  f.rt.sendMessage(f.t.id, { text: '@gam please join' });
  await settle(f.rt);
  assert.equal(mentionAsks(f), false, '@gamma’s decline holds');
});

test('#789 the lift holds after a restart, since the mark is in the store', async () => {
  const f = await declined();
  f.rt.sendMessage(f.t.id, { text: '@gamma please join' });
  await settle(f.rt);
  const { Runtime } = await import('../server/runtime.mjs');
  const rt = new Runtime({ store: f.store, adapters: f.rt.adapters, config: f.rt.config });
  const gamma = rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  rt.deleteSession(gamma.id);
  rt.purgeSession(gamma.id);
  assert.equal(mentionAsks(f, rt), true);
});

test('#789 the person’s add behind a held commit lifts a decline held with it', async () => {
  const h = await heldStore();
  const f = setup(h.store);
  await says(f, f.alpha, 'Let’s ask @gamma to check the numbers.');
  const [card] = addCards(f);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  f.rt.resolveHop(f.t.id, card.id, false);
  f.rt.sendMessage(f.t.id, { text: '@gamma please join' });
  h.release();
  await commit;
  await h.store.flush();
  await settle(f.rt);
  removeGamma(f);
  assert.equal(mentionAsks(f), true, 'the decline and the add were held together: the add is the latest answer');
  await h.store.close();
});
