// Side threads (#110, #121, #128, #228): one session per persona per conversation. A wake runs in the agent’s session in
// the conversation and shows in the side thread; while that session is busy, the wake waits for its turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, sessionsOfPersona, settle, setup, sideOf, sleep } from './side-threads-fixture.mjs';

test('#110: a wake runs in the agent’s own session in the conversation, and shows in the side thread', async () => {
  const { store, rt, adapter, t, b, alpha, beta } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.agentWake(alpha.id, 'beta', 'Which editions did you use?');
  await sleep(5);
  const side = sideOf(store, t);
  // No second @beta: its conversation session took the wake, in the side thread.
  assert.deepEqual(
    sessionsOfPersona(store, b.id).map((x) => x.id),
    [beta.id],
  );
  assert.deepEqual(side.members, []);
  assert.equal(adapter.calls.at(-1).sessionId, beta.id);
  assert.equal(adapter.calls.at(-1).thread, side.id);
  // While it works, the session says where (#121).
  assert.deepEqual(store.state.sessions[beta.id].sideTurn, { threadId: side.id, by: 'alpha' });
  h.release();
  await settle(rt);
  const reply = store.items(side.id).find((i) => i.kind === 'agent' && i.handle === 'beta');
  assert.equal(reply.sessionId, beta.id);
  assert.equal(reply.text, 'working on it');
  assert.equal(
    store.items(t.id).some((i) => i.kind === 'agent' && i.handle === 'beta'),
    false,
    'the reply is in the side thread, not the conversation',
  );
  assert.equal(store.state.sessions[beta.id].sideTurn, null);
  // Its reply went back to the session that woke it, as before.
  assert.ok(adapter.calls.some((c) => c.sessionId === alpha.id && c.message.kind === 'agent' && c.message.from === '@beta'));
  // The next thing you ask @beta in the conversation goes to the same session: the one that remembers the exchange.
  rt.sendMessage(t.id, { text: '@beta what did you tell alpha?' });
  await settle(rt);
  assert.equal(adapter.calls.at(-1).sessionId, beta.id);
  assert.equal(adapter.calls.at(-1).thread, t.id);
});

test('#228: a wake while the session is busy waits for its turn, as a message to a busy agent does: no fork', async () => {
  const { store, rt, adapter, t, b, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start the long job' });
  adapter.next.push(async (c) => c.text('The editions are 1st and 3rd.'));
  const r = rt.agentWake(alpha.id, 'beta', 'Which editions?');
  assert.equal(r.message, 'Woke @beta: it’s busy, so it answers when its current turn ends.');
  await sleep(10);
  assert.deepEqual(
    sessionsOfPersona(store, b.id).map((x) => x.id),
    [beta.id],
  );
  // It waits in the side thread’s queue, where the person sees it and can remove it (#228).
  const [q] = sideOf(store, t).queue;
  assert.deepEqual([q.kind, q.from, q.text, q.sessionIds], ['wake', 'alpha', 'Which editions?', [beta.id]]);
  busy.release();
  await settle(rt);
  const answer = adapter.calls.find((x) => x.message.text === 'Which editions?');
  assert.deepEqual([answer.sessionId, answer.thread], [beta.id, sideOf(store, t).id]);
  assert.equal(
    Object.values(store.state.sessions).some((x) => x.forkOf),
    false,
  );
});

test('#110: a second wake while the session is busy in that same side thread waits for its turn, and starts no fork', async () => {
  const { store, rt, adapter, t, b, alpha, beta } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  await sleep(5);
  const side = sideOf(store, t);
  adapter.next.push(async (c) => c.text('Dates: 1999 and 2004.'));
  rt.agentWake(alpha.id, 'beta', 'And the dates?');
  assert.deepEqual(
    sessionsOfPersona(store, b.id).map((x) => x.id),
    [beta.id],
  );
  assert.equal(store.state.threads[side.id].queue.length, 1);
  h.release();
  await settle(rt);
  const second = adapter.calls.find((c) => c.message.text === 'And the dates?');
  assert.deepEqual([second.sessionId, second.thread], [beta.id, side.id]);
});

test('#128: @-mentioning an agent in a side thread reaches its session in the conversation, not a new copy', async () => {
  const { store, rt, adapter, t, a, b, alpha, beta } = setup();
  rt.agentWake(alpha.id, 'beta', 'Look at this.');
  await settle(rt);
  const side = sideOf(store, t);
  rt.sendMessage(side.id, { text: '@alpha post the details in the main chat' });
  await settle(rt);
  assert.equal(sessionsOfPersona(store, a.id).length, 1);
  assert.equal(adapter.calls.at(-1).sessionId, alpha.id);
  assert.equal(adapter.calls.at(-1).thread, side.id);
  // No mention: the last speaker there answers, from its own session.
  rt.sendMessage(side.id, { text: 'and you?' });
  await settle(rt);
  assert.equal(adapter.calls.at(-1).sessionId, alpha.id);
  assert.equal(sessionsOfPersona(store, b.id).length, 1);
  assert.equal(store.state.sessions[beta.id].threadId, t.id);
});

test('#110: an agent asking permission in a side thread needs you there: the card and its needs name that thread', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  /** @type {any} */
  let asked = null;
  adapter.next.push(async (c) => {
    asked = c.askPermission({ tool: 'Bash', summary: 'run tests' });
    await asked;
  });
  rt.agentWake(alpha.id, 'beta', 'Run the tests.');
  await sleep(10);
  const side = sideOf(store, t);
  const se = store.state.sessions[beta.id];
  assert.equal(se.state, 'needs');
  assert.equal(se.needs.kind, 'permission');
  assert.equal(se.needs.threadId, side.id);
  assert.ok(store.item(side.id, se.needs.itemId), 'the card is in the side thread');
  rt.act(side.id, se.needs.itemId, 'allow');
  await settle(rt);
  assert.equal((await asked).allow, true);
});

test('#110: read_conversation reads another thread of the same conversation by id, and refuses any other', async () => {
  const { store, rt, t, alpha, a } = setup();
  rt.agentWake(alpha.id, 'beta', 'The plan is X.');
  await settle(rt);
  const side = sideOf(store, t);
  const tools = rt.toolsFor(alpha.id);
  assert.match(tools.read_conversation({ thread: side.id }).message, /\] You \(@alpha\): The plan is X\.\n\n\[it_\w+\] @beta: ok/);
  const other = rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [a.id] });
  const r = tools.read_conversation({ thread: other.id });
  assert.equal(r.ok, false);
  assert.match(r.message, /no thread .* in this conversation/);
});

test('#110: a message you queued for an agent busy in a side thread goes once that turn ends', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.agentWake(alpha.id, 'beta', 'Long one.');
  const r = rt.sendMessage(t.id, { text: '@beta when you can' });
  assert.ok(r.queued);
  h.release();
  await settle(rt);
  assert.equal(store.state.threads[t.id].queue.length, 0);
  assert.ok(adapter.calls.some((c) => c.sessionId === beta.id && c.thread === t.id && c.message.text === '@beta when you can'));
});

test('#110: an item read_conversation cut in a side thread can be read in full with read_message, and not from another conversation', async () => {
  const { store, rt, adapter, t, a, b, alpha, beta } = setup();
  // The side thread isn’t in @alpha’s lineage, just as a fork’s side thread isn’t in its session’s.
  const long = `The fork’s findings. ${'Each edition checked against the catalog. '.repeat(120)}The last paragraph: ship it.`;
  adapter.next.push(async (c) => c.text(long));
  rt.agentWake(alpha.id, 'beta', 'Report back in full.');
  await settle(rt);
  const side = sideOf(store, t);
  const reply = store.items(side.id).find((i) => i.kind === 'agent' && i.sessionId === beta.id);
  const tools = rt.toolsFor(alpha.id);
  const read = tools.read_conversation({ thread: side.id });
  assert.match(read.message, new RegExp(`read_message \\{ id: "${reply.id}" \\} has the rest`));
  const full = tools.read_message({ id: reply.id });
  assert.equal(full.ok, true);
  assert.match(full.message, /The last paragraph: ship it\.$/);
  // An item of another conversation is out of reach, as read_conversation’s threads are.
  const other = rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [a.id, b.id] });
  const theirs = rt.addItem(other.id, { kind: 'agent', sessionId: 'x', handle: 'beta', text: 'Not yours.', status: 'done' });
  assert.equal(tools.read_message({ id: theirs.id }).ok, false);
});

test('#121: the catch-up line for a side thread gives its id, so an agent can read it', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  rt.agentWake(alpha.id, 'beta', 'Check this.');
  await settle(rt);
  const side = sideOf(store, t);
  rt.sendMessage(t.id, { text: '@gamma what happened?' });
  await settle(rt);
  const ctx = adapter.calls.at(-1).message.context.join('\n');
  assert.match(ctx, new RegExp(`@alpha and @beta talked in a side thread \\(\\d+ messages?; read_conversation with thread: "${side.id}" reads it\\)`));
});

test('#121: a link to a thread of the conversation in your message reaches the agent with the thread’s id and title', async () => {
  const { store, rt, adapter, t, a, alpha } = setup();
  rt.agentWake(alpha.id, 'beta', 'Check this.');
  await settle(rt);
  const side = sideOf(store, t);
  const other = rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [a.id] });
  rt.sendMessage(t.id, { text: `@alpha look at [it](http://127.0.0.1:4400/#/t/${t.id}/side/${side.id}) and #/t/${other.id}` });
  await settle(rt);
  const call = adapter.calls.findLast((c) => c.sessionId === alpha.id && c.message.kind === 'user');
  const refs = call.message.context.filter((x) => x.includes('links to'));
  assert.deepEqual(refs, [
    `[Postbox] The person’s message links to the side thread “${side.title}” (thread ${side.id}). Read it with read_conversation with thread: "${side.id}".`,
  ]);
});

test('a turn’s room is its conversation’s other agents with their roles, in a side thread too', () => {
  const { rt, t, b, alpha } = setup();
  rt.updatePersona(b.id, { description: 'Reviews code.' });
  const room = rt.roomOf(t.id, alpha);
  assert.deepEqual(
    room.map((r) => r.handle),
    ['beta'],
  );
  assert.equal(room[0].role, rt.persona(b.id).description ?? '');
  // A side thread of the conversation has the conversation’s room, not one of its own.
  const side = rt.createThread({ projectId: 'p1', title: 'S', kind: 'side', parentId: t.id });
  assert.deepEqual(rt.roomOf(side.id, alpha), room);
});
