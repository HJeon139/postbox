// Reactions (#251): the person reacts to a message, block or app, and the room’s agents hear it once, as feedback, in
// their next catch-up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

/** A room where alpha has replied once, and the reply to react to. */
async function replied() {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('The parser drops entries whose year sits in a note field.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha why is the list short?' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((x) => x.kind === 'agent');
  return { ...f, reply };
}
const react = (f, item, emoji, threadId = f.t.id) => f.rt.act(threadId, item.id, '@react', { emoji });
const turnContext = (call) => [call.message.taskContext, ...(call.message.context ?? [])].filter(Boolean).join('\n');
/** What each agent’s next turn starts with. */
async function nextTurns(f, text) {
  const before = f.adapter.calls.length;
  f.rt.sendMessage(f.t.id, { text });
  await settle(f.rt);
  return f.adapter.calls.slice(before).map((c) => [c.handle, turnContext(c)]);
}

test('#251: a reaction is added, and clicking it again takes it back', async () => {
  const f = await replied();
  assert.deepEqual(
    react(f, f.reply, '👎').reactions.map((r) => r.emoji),
    ['👎'],
  );
  react(f, f.reply, '🚩');
  assert.deepEqual(
    f.store.item(f.t.id, f.reply.id).reactions.map((r) => r.emoji),
    ['👎', '🚩'],
  );
  react(f, f.reply, '👎');
  assert.deepEqual(
    f.store.item(f.t.id, f.reply.id).reactions.map((r) => r.emoji),
    ['🚩'],
  );
  assert.throws(() => react(f, f.reply, '🎉'), /React with one of/);
  const line = f.rt.addItem(f.t.id, { kind: 'system', variant: 'joined', to: 'beta' });
  assert.throws(() => react(f, line, '👍'), /a message, a block or an app/);
});

test('#251: the reacted-to agent hears it once, at its next turn, and another agent sees it in its catch-up', async () => {
  const f = await replied();
  react(f, f.reply, '👎');
  const [[who, heard]] = await nextTurns(f, '@alpha try again');
  assert.equal(who, 'alpha');
  assert.match(heard, /You reacted 👎 to @alpha’s message \(yours: take it as feedback\) at \d\d:\d\d: “The parser drops entries/);
  // Once: the turn after doesn’t hear it again.
  const [[, again]] = await nextTurns(f, '@alpha and now?');
  assert.doesNotMatch(again, /reacted/);
  // beta, which wasn’t there for it, reads it in its first catch-up, as the room’s.
  const [[b, seen]] = await nextTurns(f, '@beta what do you make of it?');
  assert.equal(b, 'beta');
  assert.match(seen, /You reacted 👎 to @alpha’s message at/);
  assert.doesNotMatch(seen, /yours/);
});

test('#251: a reaction taken back before the agent’s turn isn’t told, and one on a block doesn’t answer it', async () => {
  const f = await replied();
  react(f, f.reply, '❓');
  react(f, f.reply, '❓');
  const [[, heard]] = await nextTurns(f, '@alpha go on');
  assert.doesNotMatch(heard, /reacted/);
  const se = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'alpha');
  f.rt
    .toolsFor(se.id)
    .show_block({ block: { id: 'pick', type: 'choice', version: 1, fallback: 'Pick one', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] } });
  const block = f.store.items(f.t.id).find((x) => x.kind === 'block');
  react(f, block, '✅');
  const now = f.store.item(f.t.id, block.id);
  assert.equal(now.answered, false);
  assert.deepEqual(
    now.reactions.map((r) => r.emoji),
    ['✅'],
  );
  assert.ok(!f.store.items(f.t.id).some((x) => x.kind === 'voice'), 'a reaction says nothing in your voice');
});

test('#251: a reaction in a topic thread reaches the agent answering there, and no one in the conversation', async () => {
  const f = await replied();
  const topic = f.rt.startTopic(f.t.id, f.reply.id).threadId;
  f.adapter.next.push(async (c) => c.text('In the thread: the year field is the cause.'));
  f.rt.sendMessage(topic, { text: '@alpha say more here' });
  await settle(f.rt);
  const there = f.store.items(topic).find((x) => x.kind === 'agent');
  react(f, there, '🚩', topic);
  // beta, in the conversation, isn’t told of a reaction in a thread it isn’t in.
  const [[b, room]] = await nextTurns(f, '@beta anything new?');
  assert.equal(b, 'beta');
  assert.doesNotMatch(room, /reacted/);
  // alpha, answering in the thread, is: once.
  const before = f.adapter.calls.length;
  f.rt.sendMessage(topic, { text: '@alpha and?' });
  await settle(f.rt);
  const heard = turnContext(f.adapter.calls[before]);
  assert.match(heard, /You reacted 🚩 to @alpha’s message \(yours: take it as feedback\)/);
  f.rt.sendMessage(topic, { text: '@alpha once more?' });
  await settle(f.rt);
  assert.doesNotMatch(turnContext(f.adapter.calls.at(-1)), /reacted/);
});

test('#251: an agent’s card action named react stays the card’s, and the event records what the reaction was', async () => {
  const f = await replied();
  const se = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'alpha');
  f.rt.toolsFor(se.id).show_block({ block: { id: 'c', type: 'card', version: 1, fallback: 'A card', actions: [{ id: 'react', label: 'React' }] } });
  const card = f.store.items(f.t.id).find((x) => x.kind === 'block');
  const r = await f.rt.act(f.t.id, card.id, 'react', {});
  assert.match(r.voice, /^React/);
  assert.equal(f.store.item(f.t.id, card.id).reactions, undefined);
  const seen = [];
  f.store.subscribe((ev) => ev.type === 'item.patch' && ev.data.reaction && seen.push(ev.data));
  react(f, f.reply, '👍');
  react(f, f.reply, '👍');
  assert.deepEqual(
    seen.map((d) => [d.id, d.reaction.emoji, d.reaction.on]),
    [
      [f.reply.id, '👍', true],
      [f.reply.id, '👍', false],
    ],
  );
  assert.ok(seen.every((d) => Number.isFinite(d.reaction.at)));
});

test('#251: a reply still being written, or a deleted agent’s, takes no reaction; one in the same millisecond is still told', async () => {
  const f = await replied();
  f.rt.patchItem(f.t.id, f.reply.id, { status: 'streaming' });
  assert.throws(() => react(f, f.reply, '👍'), /still being written/);
  f.rt.patchItem(f.t.id, f.reply.id, { status: 'done', deletedAgent: true });
  assert.throws(() => react(f, f.reply, '👍'), /was deleted/);
  f.rt.patchItem(f.t.id, f.reply.id, { deletedAgent: false });
  // The marker is the newest reaction told, not the time of the catch-up: one at the same millisecond is told next.
  const se = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'alpha');
  const at = Date.now() + 60_000;
  f.rt.patchItem(f.t.id, f.reply.id, { reactions: [{ emoji: '👍', at }] });
  f.rt.updateSession(se.id, { reactionsTold: { [f.t.id]: { at: at - 1, keys: [] } } });
  const [[, first]] = await nextTurns(f, '@alpha one');
  assert.match(first, /reacted 👍/);
  f.rt.patchItem(f.t.id, f.reply.id, {
    reactions: [
      { emoji: '👍', at },
      { emoji: '✅', at },
    ],
  });
  const [[, second]] = await nextTurns(f, '@alpha two');
  assert.doesNotMatch(second, /👍/);
  assert.match(second, /reacted ✅/);
});
