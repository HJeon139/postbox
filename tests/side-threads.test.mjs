// Agents waking agents (#110, #121, #128, #228, #372): one session per persona per conversation. A wake runs in the
// agent’s session in the conversation, where the person reads, and its reply shows there; while that session is busy,
// the wake waits for its turn. Side threads from before #372 are history: agents read them, and no one writes in them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, oldSide, sessionsOfPersona, settle, setup, sleep } from './side-threads-fixture.mjs';

const sides = (store) => Object.values(store.state.threads).filter((x) => x.kind === 'side');

test('#110, #372: a wake runs in the agent’s own session, in the conversation; its reply shows there, and the waker gets no new turn', async () => {
  const { store, rt, adapter, t, b, alpha, beta } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.agentWake(alpha.id, 'beta', 'Which editions did you use?');
  await sleep(5);
  // No second @beta, and no side thread: its conversation session took the wake, in the conversation.
  assert.deepEqual(
    sessionsOfPersona(store, b.id).map((x) => x.id),
    [beta.id],
  );
  assert.deepEqual(sides(store), []);
  assert.equal(
    store.items(t.id).some((i) => i.kind === 'sidelink'),
    false,
  );
  assert.deepEqual([adapter.calls.at(-1).sessionId, adapter.calls.at(-1).thread], [beta.id, t.id]);
  // The wake is @alpha’s message in the conversation, with its number in the chain (#114).
  const wake = store.items(t.id).find((i) => i.kind === 'agent' && i.handle === 'alpha');
  assert.deepEqual([wake.sessionId, wake.text, wake.hop], [alpha.id, 'Which editions did you use?', 1]);
  assert.equal(adapter.calls.at(-1).message.itemId, wake.id);
  // It works in its own thread, so the session says nowhere else (#121).
  assert.equal(store.state.sessions[beta.id].sideTurn, null);
  h.release();
  await settle(rt);
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.handle === 'beta');
  assert.deepEqual([reply.sessionId, reply.text], [beta.id, 'working on it']);
  // Its reply doesn’t go back to the session that woke it: @alpha reads it at its next turn.
  assert.deepEqual(
    adapter.calls.map((c) => c.sessionId),
    [beta.id],
  );
  // The next thing you ask @beta in the conversation goes to the same session: the one that remembers the exchange.
  rt.sendMessage(t.id, { text: '@beta what did you tell alpha?' });
  await settle(rt);
  assert.deepEqual([adapter.calls.at(-1).sessionId, adapter.calls.at(-1).thread], [beta.id, t.id]);
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
  // It waits in the conversation’s queue, where the person sees it and can remove it (#228, #372).
  const [q] = store.state.threads[t.id].queue;
  assert.deepEqual([q.kind, q.from, q.text, q.sessionIds], ['wake', 'alpha', 'Which editions?', [beta.id]]);
  busy.release();
  await settle(rt);
  const answer = adapter.calls.find((x) => x.message.text === 'Which editions?');
  assert.deepEqual([answer.sessionId, answer.thread], [beta.id, t.id]);
  assert.equal(
    Object.values(store.state.sessions).some((x) => x.forkOf),
    false,
  );
  assert.deepEqual(sides(store), []);
});

test('#110, #372: a second wake while the session is busy with the first waits in the conversation’s queue, and starts no fork', async () => {
  const { store, rt, adapter, t, b, alpha, beta } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  await sleep(5);
  adapter.next.push(async (c) => c.text('Dates: 1999 and 2004.'));
  rt.agentWake(alpha.id, 'beta', 'And the dates?');
  assert.deepEqual(
    sessionsOfPersona(store, b.id).map((x) => x.id),
    [beta.id],
  );
  assert.deepEqual(
    store.state.threads[t.id].queue.map((q) => q.text),
    ['And the dates?'],
  );
  h.release();
  await settle(rt);
  const second = adapter.calls.find((c) => c.message.text === 'And the dates?');
  assert.deepEqual([second.sessionId, second.thread], [beta.id, t.id]);
});

test('#128, #372: a side thread from before is read-only: a message there is refused with where to write, and wakes no one', async () => {
  const f = setup();
  const { store, rt, adapter, a, b } = f;
  const side = oldSide(f);
  const items = store.items(side.id).length;
  for (const text of ['@alpha post the details in the main chat', 'and you?'])
    assert.throws(() => rt.sendMessage(side.id, { text }), {
      status: 409,
      message: 'Side threads are read-only now. Write in the conversation, where the agents talk.',
    });
  await settle(rt);
  assert.equal(adapter.calls.length, 0);
  assert.equal(store.items(side.id).length, items, 'nothing was added to it');
  assert.deepEqual([sessionsOfPersona(store, a.id).length, sessionsOfPersona(store, b.id).length], [1, 1]);
});

test('#372: a turn still running in a side thread from before hands off in the conversation, and its agent is told once', async () => {
  const f = setup();
  const { store, rt, adapter, t, alpha, beta } = f;
  const side = oldSide(f);
  const results = [];
  adapter.next.push(async (c) => {
    results.push(c.tools.wake_agent({ handle: 'alpha', message: 'The 1908 one, page 12.' }));
    results.push(c.tools.wake_agent({ handle: 'alpha', message: 'And page 40.' }));
    c.text('Told alpha.');
  });
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: 'Which page?' }, { threadId: side.id });
  await settle(rt);
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true],
  );
  // Its reply stays in the side thread; the wakes and @alpha’s answers are in the conversation.
  assert.ok(store.items(side.id).some((i) => i.sessionId === beta.id && i.text === 'Told alpha.'));
  assert.deepEqual(
    store
      .items(t.id)
      .filter((i) => i.kind === 'agent' && i.handle === 'beta')
      .map((i) => [i.text, i.hop]),
    [
      ['The 1908 one, page 12.', 1],
      ['And page 40.', 2],
    ],
  );
  assert.deepEqual(
    adapter.calls.filter((c) => c.sessionId === alpha.id).map((c) => [c.thread, c.message.text]),
    [
      [t.id, 'The 1908 one, page 12.'],
      [t.id, 'And page 40.'],
    ],
  );
  const told = (store.state.sessions[beta.id].context ?? []).filter((x) => /Side threads are gone/.test(x));
  assert.equal(told.length, 1);
  assert.equal(store.state.sessions[beta.id].toldSideThreadsGone, true);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'sidelink').length, 1, 'no new side thread or line');
});

test('#110, #372: an agent woken from a topic thread that asks for permission needs you there: the card and its needs name that thread', async () => {
  const { store, rt, adapter, t, beta } = setup();
  adapter.next.push(async (c) => c.text('Here is the plan.'));
  rt.sendMessage(t.id, { text: '@alpha a plan' });
  await settle(rt);
  const reply = store.items(t.id).find((i) => i.kind === 'agent');
  const topic = store.state.threads[rt.startTopic(t.id, reply.id).threadId];
  /** @type {any} */
  let asked = null;
  adapter.next.push(async (c) => {
    c.tools.wake_agent({ handle: 'beta', message: 'Run the tests.' });
    c.text('Asked beta.');
  });
  adapter.next.push(async (c) => {
    asked = c.askPermission({ tool: 'Bash', summary: 'run tests' });
    await asked;
  });
  rt.sendMessage(topic.id, { text: '@alpha get the tests run' });
  for (let i = 0; i < 200 && !asked; i++) await sleep(5);
  await sleep(5);
  // @beta answers where @alpha spoke, in the topic thread, from its session in the conversation.
  assert.deepEqual([adapter.calls.at(-1).sessionId, adapter.calls.at(-1).thread], [beta.id, topic.id]);
  const se = store.state.sessions[beta.id];
  assert.equal(se.state, 'needs');
  assert.equal(se.needs.kind, 'permission');
  assert.equal(se.needs.threadId, topic.id);
  assert.ok(store.item(topic.id, se.needs.itemId), 'the card is in the topic thread');
  assert.deepEqual(sides(store), []);
  rt.act(topic.id, se.needs.itemId, 'allow');
  await settle(rt);
  assert.equal((await asked).allow, true);
});

test('#110: read_conversation reads another thread of the same conversation by id, and refuses any other', async () => {
  const f = setup();
  const { rt, alpha, a } = f;
  const side = oldSide(f, ['The plan is X.', 'ok']);
  const tools = rt.toolsFor(alpha.id);
  assert.match(tools.read_conversation({ thread: side.id }).message, /\] You \(@alpha\): The plan is X\.\n\n\[it_\w+\] @beta: ok/);
  const other = rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [a.id] });
  const r = tools.read_conversation({ thread: other.id });
  assert.equal(r.ok, false);
  assert.match(r.message, /no thread .* in this conversation/);
});

test('#110: a message you queued for an agent busy with a wake goes once that turn ends', async () => {
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
  const f = setup();
  const { store, rt, a, b, alpha, beta } = f;
  // The side thread isn’t in @alpha’s lineage, just as a fork’s side thread isn’t in its session’s.
  const long = `The fork’s findings. ${'Each edition checked against the catalog. '.repeat(120)}The last paragraph: ship it.`;
  const side = oldSide(f, ['Report back in full.', long]);
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

test('#121: the catch-up line for a side thread from before gives its id, so an agent can read it', async () => {
  const f = setup();
  const { rt, adapter, t } = f;
  const side = oldSide(f, ['Check this.', 'ok']);
  rt.sendMessage(t.id, { text: '@gamma what happened?' });
  await settle(rt);
  const ctx = adapter.calls.at(-1).message.context.join('\n');
  assert.match(ctx, new RegExp(`@alpha and @beta talked in a side thread \\(2 messages; read_conversation with thread: "${side.id}" reads it\\)`));
});

test('#121: a link to a thread of the conversation in your message reaches the agent with the thread’s id and title', async () => {
  const f = setup();
  const { rt, adapter, t, a, alpha } = f;
  const side = oldSide(f, ['Check this.', 'ok']);
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
