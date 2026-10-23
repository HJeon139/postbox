// Side threads (#110, #121, #128): one session per persona per conversation. A wake runs in the agent’s session in the
// conversation and shows in the side thread; only while that session is busy does a fork of it answer.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An adapter whose replies the test scripts per call; a step can hold its turn open until the test lets it go. */
class ScriptedAdapter {
  name = 'mock';
  constructor() {
    this.calls = [];
    this.next = [];
    this.forks = [];
  }
  fork(source, target) {
    this.forks.push([source.id, target.id]);
  }
  async deliver(session, message, ctx) {
    this.calls.push({ handle: session.handle, sessionId: session.id, message, thread: ctx.thread.id, state: ctx.state });
    ctx.saveState({ backendSession: `cli-${session.id}` });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx, message, session);
  }
}

function setup() {
  const store = new Store(null);
  const adapter = new ScriptedAdapter();
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'alpha' });
  const b = rt.createPersona({ handle: 'beta' });
  const c = rt.createPersona({ handle: 'gamma' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id, b.id] });
  const [alpha, beta] = rt.sessionsIn(t.id);
  return { store, rt, adapter, t, a, b, c, alpha, beta };
}
const settle = async (rt) => {
  for (let i = 0; i < 200 && (rt.turns.size || rt.exiting.size); i++) await sleep(5);
  await sleep(5);
};
/** A step that holds its turn open until release() is called. */
function held() {
  let release = () => {};
  const done = new Promise((r) => {
    release = r;
  });
  return {
    release: () => release(),
    step: async (c) => {
      c.text('working on it');
      await done;
    },
  };
}
const sideOf = (store, t) => Object.values(store.state.threads).find((x) => x.kind === 'side' && x.parentId === t.id);
const sessionsOfPersona = (store, personaId) => Object.values(store.state.sessions).filter((x) => x.personaId === personaId);

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

test('#110: a persona woken from outside the conversation joins it, so a later wake or mention reaches the same session', async () => {
  const { store, rt, adapter, t, c, alpha, beta } = setup();
  rt.agentWake(alpha.id, 'gamma', 'Check the numbers.');
  await settle(rt);
  const gammas = sessionsOfPersona(store, c.id);
  assert.equal(gammas.length, 1);
  assert.equal(gammas[0].threadId, t.id, 'it joined the conversation');
  assert.ok(store.state.threads[t.id].members.includes(gammas[0].id));
  // The person never added it, so the session and the wake’s line say why it’s here (the person’s decision).
  assert.equal(gammas[0].joinedBy, 'alpha');
  const wakes = store.items(t.id).filter((i) => i.kind === 'system' && i.variant === 'wake' && i.to === 'gamma');
  assert.equal(wakes[0].joined, true);
  // A different partner wakes it: another side thread, the same session.
  rt.agentWake(beta.id, 'gamma', 'And mine?');
  await settle(rt);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'system' && i.variant === 'wake' && i.to === 'gamma')[1].joined, undefined, 'it joined only once');
  assert.equal(sessionsOfPersona(store, c.id).length, 1);
  assert.equal(Object.values(store.state.threads).filter((x) => x.kind === 'side').length, 2);
  rt.sendMessage(t.id, { text: '@gamma summarize both' });
  await settle(rt);
  assert.equal(adapter.calls.at(-1).sessionId, gammas[0].id);
});

test('#110: only while the session is mid-turn does a fork of it answer, at its latest point, and the session gets a pointer', async () => {
  const { store, rt, adapter, t, b, alpha, beta } = setup();
  // @beta is busy in the conversation.
  rt.sendMessage(t.id, { text: '@beta first warm up' });
  await settle(rt);
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start the long job' });
  assert.ok(rt.turns.has(beta.id));
  adapter.next.push(async (c) => c.text('Fork: the editions are 1st and 3rd.'));
  const r = rt.agentWake(alpha.id, 'beta', 'Which editions?');
  assert.match(r.message, /a fork of it answers/);
  await sleep(10);
  const side = sideOf(store, t);
  const forks = sessionsOfPersona(store, b.id).filter((x) => x.id !== beta.id);
  assert.equal(forks.length, 1);
  const fork = forks[0];
  assert.equal(fork.threadId, side.id);
  assert.deepEqual(fork.forkOf, { sessionId: beta.id, itemId: null, busy: true, by: 'alpha', first: false });
  // From the session’s latest point: what its backend saved, not a checkpoint of a message.
  assert.deepEqual(fork.backendState.forkFrom, store.state.sessions[beta.id].backendState);
  assert.deepEqual(adapter.forks, [[beta.id, fork.id]]);
  const forkCall = adapter.calls.find((x) => x.sessionId === fork.id);
  assert.match(forkCall.message.context.join('\n'), /fork of your session in the conversation “T”/);
  // A second wake while @beta is still busy reuses the fork.
  adapter.next.push(async (c) => c.text('Fork again.'));
  rt.agentWake(alpha.id, 'beta', 'And the dates?');
  await sleep(20);
  assert.equal(sessionsOfPersona(store, b.id).length, 2);
  busy.release();
  await settle(rt);
  // The pointer names the thread; Postbox sends neither the fork’s summary nor its messages.
  const pointer = (store.state.sessions[beta.id].context ?? []).filter((x) => x.includes(side.id));
  assert.equal(pointer.length, 1, 'one pointer per thread, replaced, not piled up');
  assert.match(pointer[0], /read_conversation with thread: "th_[^"]+" and limit: 1/);
  assert.doesNotMatch(pointer[0], /editions are 1st/);
  // It reaches @beta’s next turn, which can then read the fork’s summary.
  rt.sendMessage(t.id, { text: '@beta anything new?' });
  await settle(rt);
  const next = adapter.calls.at(-1);
  assert.equal(next.sessionId, beta.id);
  assert.ok(next.message.context.some((x) => x.includes(`thread ${side.id}`)));
  const summary = rt.toolsFor(beta.id).read_conversation({ thread: side.id, limit: 1 });
  assert.equal(summary.ok, true);
  assert.match(summary.message, /Fork again\./);
});

test('#110: a second wake while the session is busy in that same side thread waits for its turn, and starts no fork', async () => {
  const { store, rt, adapter, t, b, alpha, beta } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  await sleep(5);
  const side = sideOf(store, t);
  adapter.next.push(async (c) => c.text('Dates: 1999 and 2004.'));
  const r = rt.agentWake(alpha.id, 'beta', 'And the dates?');
  assert.equal(r.message, 'Woke @beta.');
  assert.deepEqual(
    sessionsOfPersona(store, b.id).map((x) => x.id),
    [beta.id],
    'a fork would be a second @beta doing the same work',
  );
  assert.equal(rt.turns.get(beta.id).pending.length, 1);
  h.release();
  await settle(rt);
  const second = adapter.calls.find((c) => c.message.text === 'And the dates?');
  assert.equal(second.sessionId, beta.id);
  assert.equal(second.thread, side.id);
});

test('#110: a fork that can’t start from its session’s memory starts again fresh, once, and its note says why', async () => {
  const { store, rt, adapter, t, b, alpha, beta } = setup();
  rt.sendMessage(t.id, { text: '@beta first warm up' });
  await settle(rt);
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta the long job' });
  // The backend can’t resume a session whose transcript is still being written: the fork’s first turn fails at once.
  adapter.next.push(async (c) => {
    if (c.state.forkFrom) throw new Error('No conversation found to resume');
    c.text('Should not run here.');
  });
  adapter.next.push(async (c) => c.text('Fresh: the editions are 1st and 3rd.'));
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  await sleep(30);
  const fork = sessionsOfPersona(store, b.id).find((x) => x.id !== beta.id);
  const side = sideOf(store, t);
  const tries = adapter.calls.filter((c) => c.sessionId === fork.id);
  assert.equal(tries.length, 2);
  assert.ok(tries[0].state.forkFrom, 'it tried the session’s memory first');
  assert.equal(tries[1].state.forkFrom, undefined, 'then fresh');
  assert.equal(tries[1].message.text, 'Which editions?');
  assert.match(
    tries[1].message.context.join('\n'),
    /this is a new session of you, and it doesn’t remember the conversation \(starting from its memory failed: No conversation found to resume\)/,
  );
  assert.equal(store.state.sessions[fork.id].forkOf.fresh, true);
  assert.equal(store.items(side.id).filter((i) => i.status === 'failed').length, 0, 'the failed try left nothing in the thread');
  assert.ok(store.items(side.id).some((i) => i.kind === 'agent' && i.text === 'Fresh: the editions are 1st and 3rd.'));
  busy.release();
  await settle(rt);
});

test('#110: a fork whose adapter fails to fork starts fresh at once', async () => {
  const { store, rt, adapter, t, b, alpha, beta } = setup();
  adapter.fork = () => {
    throw new Error('fork refused');
  };
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta the long job' });
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  await sleep(10);
  const fork = sessionsOfPersona(store, b.id).find((x) => x.id !== beta.id);
  assert.equal(store.state.sessions[fork.id].forkOf.fresh, true);
  assert.equal(adapter.calls.find((c) => c.sessionId === fork.id).state.forkFrom, undefined);
  busy.release();
  await settle(rt);
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
  assert.match(tools.read_conversation({ thread: side.id }).message, /You \(@alpha\): The plan is X\.\n\n@beta: ok/);
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
