// #1543: an agent woken by another agent’s reply, with nothing to add, ended its turn on purpose: no words, no step, no
// tool. Postbox read that as the dropped report of #485 and showed the person a failed reply with Retry, an alarm the
// person can’t act on (designs/developing.md, “Design habits”). An exchange between agents may end quietly; a turn
// that took steps and said nothing is still #485’s case, and still fails (tests/empty-reply.test.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { settle, setup } from './blocks-fixture.mjs';

/** critic and researcher in one room; researcher answers critic’s update, which goes back to critic as a wake. */
function room() {
  const f = setup();
  const other = f.rt.createPersona({ handle: 'researcher' });
  f.rt.ensureSession(f.t.id, other.id);
  const critic = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.handle === 'critic');
  return { ...f, critic };
}

test('#1543: an agent-woken turn that ends with no words and no step ends quietly, not as a failed reply', async () => {
  const { store, rt, adapter, t, critic } = room();
  adapter.next.push(async (c) => c.text('I’ll acknowledge the update. @researcher noted.'));
  adapter.next.push(async (c) => c.text('I’m waiting for the person to pick the figure.'));
  // critic, woken by researcher’s reply, has nothing to add and ends its turn on purpose.
  adapter.next.push(async () => {});
  rt.sendMessage(t.id, { text: '@critic review the figure update' });
  await settle(rt);
  const woken = adapter.calls.filter((x) => x.sessionId === critic.id);
  assert.equal(woken.length, 2, 'critic was woken back by researcher’s reply');
  assert.equal(woken[1].parts[0].kind, 'agent', 'by another agent');
  const failed = store.items(t.id).filter((i) => i.status === 'failed');
  assert.deepEqual(failed, [], 'no failed reply');
  assert.notEqual(store.state.sessions[critic.id].needs?.kind, 'failed', 'the person isn’t asked to act');
  assert.ok(!(store.state.sessions[critic.id].context ?? []).some((c) => /ended without a reply/i.test(c)), 'critic isn’t told its reply was lost');
  assert.ok(
    !store.items(t.id).some((i) => i.kind === 'agent' && i.sessionId === critic.id && i.status === 'done' && !i.text?.trim()),
    'and no empty message is posted (#485)',
  );
});

test('#1543: an agent-woken turn that took a step and said nothing still fails, as #485', async () => {
  const { store, rt, adapter, t, critic } = room();
  adapter.next.push(async (c) => c.text('Over to you. @researcher check the numbers.'));
  adapter.next.push(async (c) => c.text('The numbers hold.'));
  adapter.next.push(async (c) => c.activity({ id: 's1', label: 'Ran npm test', state: 'done' }));
  rt.sendMessage(t.id, { text: '@critic review the figure update' });
  await settle(rt);
  const last = store
    .items(t.id)
    .filter((i) => i.kind === 'agent' && i.sessionId === critic.id)
    .at(-1);
  assert.equal(last.status, 'failed');
  assert.equal(last.error, '@critic’s turn ended without a reply.');
});

test('#1543: a turn the person started still owes a reply, even with no step', async () => {
  const { store, rt, adapter, t, critic } = room();
  adapter.next.push(async () => {});
  rt.sendMessage(t.id, { text: '@critic review the figure update' });
  await settle(rt);
  assert.equal(store.state.sessions[critic.id].needs?.kind, 'failed', 'the person asked, so silence is a dropped reply');
});

test('#1543: a woken turn that only thought ends quietly too, its thoughts kept as its record', async () => {
  // Reasoning models go quiet this way: a thought, then no words (pre-review of the first fix).
  const { store, rt, adapter, t, critic } = room();
  adapter.next.push(async (c) => c.text('I’ll acknowledge the update. @researcher noted.'));
  adapter.next.push(async (c) => c.text('I’m waiting for the person to pick the figure.'));
  adapter.next.push(async (c) => c.activity({ id: 'th1', label: 'Nothing to add', state: 'done', kind: 'thought' }));
  rt.sendMessage(t.id, { text: '@critic review the figure update' });
  await settle(rt);
  assert.deepEqual(
    store.items(t.id).filter((i) => i.status === 'failed'),
    [],
  );
  assert.notEqual(store.state.sessions[critic.id].needs?.kind, 'failed');
  const last = store
    .items(t.id)
    .filter((i) => i.kind === 'agent' && i.sessionId === critic.id)
    .at(-1);
  // A reply with steps and no words is a work record in the transcript (app/js/work-record.mjs), not an empty message.
  assert.equal(last.text?.trim() ?? '', '');
  assert.ok(
    (last.activity?.steps ?? []).some((s) => s.kind === 'thought'),
    JSON.stringify(last.activity),
  );
});

test('#1543: the person’s Retry of an agent-woken turn still owes a reply', async () => {
  const { store, rt, adapter, t, critic } = room();
  adapter.next.push(async (c) => c.text('Over to you. @researcher check the numbers.'));
  adapter.next.push(async (c) => c.text('The numbers hold.'));
  adapter.next.push(async (c) => c.activity({ id: 's1', label: 'Ran npm test', state: 'done' }));
  rt.sendMessage(t.id, { text: '@critic review the figure update' });
  await settle(rt);
  const failed = store.items(t.id).find((i) => i.status === 'failed' && i.sessionId === critic.id);
  assert.ok(failed, 'the turn with a step and no words failed');
  // The retry ends at once with nothing: the person asked for it, so it’s still a failure they see. Retry clears the
  // session’s failure first, so a failure after it is the retry’s.
  adapter.next.push(async () => {});
  await rt.retry(t.id, failed.id);
  await settle(rt);
  assert.equal(adapter.calls.filter((x) => x.sessionId === critic.id).length, 3, 'the retry ran');
  assert.equal(store.state.sessions[critic.id].needs?.kind, 'failed');
});

test('#1543: a turn another agent’s direct @-mention woke still owes its reply, even with no step', async () => {
  // Critic’s review of PR #1546: a direct assignment that ends with nothing must not look like a finished exchange.
  const { store, rt, adapter, t, critic } = room();
  const researcher = arrange.sessionsIn(rt, t.id).find((x) => x.handle === 'researcher');
  adapter.next.push(async (c) => c.text('Over to you. @researcher check the numbers.'));
  // researcher hands critic a task by @-mention, not by a reply going back.
  adapter.next.push(async (c) => c.text('@critic please check the change and report the result.'));
  adapter.next.push(async () => {});
  rt.sendMessage(t.id, { text: '@critic review the figure update' });
  await settle(rt);
  const woken = adapter.calls.filter((x) => x.sessionId === critic.id);
  assert.equal(woken.length, 2, 'critic was woken by researcher’s mention');
  assert.ok(researcher);
  assert.equal(store.state.sessions[critic.id].needs?.kind, 'failed', 'the assignment it dropped is a failed reply');
});

// #1712: Claude Code no longer re-prompts a turn that ends on Postbox’s react (CLAUDE_CODE_TERMINAL_MCP_TOOLS,
// shared/terminal-tools.mjs), so Postbox’s own check alone decides what a reaction-only ending means. A reaction is an
// answer (empty-reply.mjs, noteAnswer): the turn is answered whatever woke it, and posts no line.

/**
 * critic asks researcher, researcher plays `answer`, and critic, woken by it, only reacts to it with ✅.
 * @param {any} f @param {(c: any) => Promise<void>} answer
 */
async function reactsToTheAnswer(f, answer) {
  const { store, rt, adapter, t, critic } = f;
  adapter.next.push(async (c) => c.text('Over to you. @researcher check the numbers.'));
  adapter.next.push(answer);
  adapter.next.push(async (c) => c.tools.react({ id: answerIn(store, t, critic).id, emoji: '✅' }));
  rt.sendMessage(t.id, { text: '@critic review the figure update' });
  await settle(rt);
}

/** The reply critic reacts to: the latest from another agent, with words. */
const answerIn = (store, t, critic) =>
  store
    .items(t.id)
    .filter((i) => i.kind === 'agent' && i.sessionId !== critic.id && i.text?.trim())
    .at(-1);

/** What a reaction-only ending leaves: no failed reply, no word that it was lost, no line, and no wake past it. */
function endedOnTheReaction(f, wokeCritic) {
  const { store, adapter, t, critic } = f;
  const turns = (h) => adapter.calls.filter((x) => x.sessionId === arrange.agentIn(f.rt, t.id, h).id);
  assert.equal(turns('critic').length, 2, 'critic was woken once more');
  assert.equal(wokeCritic(turns('critic')[1]), true, 'by what the test says woke it');
  assert.deepEqual(
    store.items(t.id).filter((i) => i.status === 'failed'),
    [],
    'no failed reply',
  );
  assert.notEqual(store.state.sessions[critic.id].needs?.kind, 'failed');
  assert.ok(!(store.state.sessions[critic.id].context ?? []).some((c) => /ended without a reply/i.test(c)), 'critic isn’t told it was lost');
  const lines = store.items(t.id).filter((i) => i.kind === 'agent' && i.sessionId === critic.id && i.text?.trim());
  assert.deepEqual(
    lines.map((i) => i.text),
    ['Over to you. @researcher check the numbers.'],
    'no line after the reaction',
  );
  assert.equal(turns('researcher').length, 1, 'researcher isn’t woken again');
  assert.deepEqual(
    answerIn(store, t, critic).reactions?.map((r) => r.emoji),
    ['✅'],
  );
}

test('#1712: a turn a reply coming back woke that only reacts is answered, with no line and no failed reply', async () => {
  const f = room();
  await reactsToTheAnswer(f, async (c) => c.text('The numbers hold.'));
  endedOnTheReaction(f, (call) => call.parts.every((p) => p.kind === 'agent'));
});

test('#1712: a reply coming back with a Postbox notice beside it, answered with only a reaction, ends the same way', async () => {
  const f = room();
  await reactsToTheAnswer(f, async (c) => {
    arrange.leaveNotice(f.rt, f.critic.id, f.t.id, 'Postbox’s note: the figure app has something new.');
    c.text('The numbers hold.');
  });
  endedOnTheReaction(f, (call) => JSON.stringify(call).includes('the figure app has something new'));
});

test('#1712: a turn the person started that only reacts is answered, as on main: no failed reply and no line', async () => {
  const { store, rt, adapter, t, critic } = room();
  adapter.next.push(async (c) => c.tools.react({ id: store.items(t.id).find((i) => i.kind === 'user').id, emoji: '👍' }));
  rt.sendMessage(t.id, { text: '@critic thanks, that’s all' });
  await settle(rt);
  assert.deepEqual(
    store.items(t.id).filter((i) => i.status === 'failed'),
    [],
  );
  assert.equal(store.state.sessions[critic.id].needs, null, 'its reaction was its answer (#485)');
  assert.ok(!store.items(t.id).some((i) => i.kind === 'agent' && i.sessionId === critic.id && i.text?.trim()), 'no line');
});

test('#1712: a turn another agent’s direct @-mention woke that only reacts is answered too: a reaction is a reply', async () => {
  // A direct ask still owes a reply (#1543), and a reaction counts as one (noteAnswer): nothing fails, nothing posts.
  const f = room();
  await reactsToTheAnswer(f, async (c) => c.text('@critic please confirm you saw the change.'));
  endedOnTheReaction(f, (call) => call.parts.some((p) => p.kind === 'agent' && /please confirm/.test(p.text)));
});
