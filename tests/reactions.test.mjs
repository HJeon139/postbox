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
const react = (f, item, emoji) => f.rt.act(f.t.id, item.id, 'react', { emoji });
/** What each agent’s next turn starts with. */
async function nextTurns(f, text) {
  const before = f.adapter.calls.length;
  f.rt.sendMessage(f.t.id, { text });
  await settle(f.rt);
  return f.adapter.calls.slice(before).map((c) => [c.handle, (c.message.context ?? []).join('\n')]);
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
  const wake = f.store.items(f.t.id).find((x) => x.kind === 'system');
  assert.throws(() => react(f, wake, '👍'), /a message, a block or an app/);
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
