// A thread’s catch-up cuts a message that @-mentions its agent at READING.mention, not READING.item (#507, #652), as the
// conversation’s does (tests/catch-up-whole-mentions.test.mjs). The #507 spec’s ask is 230 characters, under both caps,
// so it can’t tell them apart: these are past READING.item. The agents are tests/side-threads-fixture.mjs’s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { threadCatchUp } from '../server/thread-summary.mjs';
import { READING } from '../shared/limits.mjs';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** A topic thread on alpha’s reply in the conversation, and a way for beta to post there. */
async function topic() {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('The totals are off by one.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha check the totals' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((i) => i.kind === 'agent');
  const { threadId } = f.rt.startTopic(f.t.id, reply.id);
  const say = (text) =>
    arrange.post(f.rt, threadId, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text, status: 'done' });
  const catchUp = () => threadCatchUp(f.rt, f.store.state.sessions[f.alpha.id], threadId) ?? '';
  return { say, catchUp };
}
/** A message of about 5,000 characters that starts with `start`. @param {string} start */
const long = (start) => `${start} ${'The figures for each region follow, line by line. '.repeat(100)}`;
/** The pointer a cut line ends with, for a cut at `at` of `text`. */
const pointer = (at, text) => new RegExp(`${at.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters; read_message \\{ id: "`);

test('#652 a 5,000-character mention in a thread’s catch-up is kept whole, with no read_message pointer', async () => {
  const f = await topic();
  const text = long('@alpha please recount the totals.');
  assert.ok(text.length > READING.item, 'past the cap on other items');
  f.say(text);
  const s = f.catchUp();
  assert.ok(s.includes(text), 'the mention is whole');
  assert.doesNotMatch(s, /characters; read_message/);
});

test('#652 a 5,000-character message in a thread that doesn’t mention the agent is cut at 2,000, with the pointer', async () => {
  const f = await topic();
  const text = long('The review has seven findings.');
  f.say(text);
  const s = f.catchUp();
  assert.ok(!s.includes(text), 'it isn’t whole');
  assert.ok(s.includes(text.slice(0, READING.item)), 'its first 2,000 characters are there');
  assert.match(s, pointer(READING.item, text));
});

test('#652 a mention in a thread past READING.mention is cut there, with the pointer', async () => {
  const f = await topic();
  const text = `@alpha ${'x'.repeat(READING.mention + 500)}`;
  f.say(text);
  const s = f.catchUp();
  assert.ok(s.includes(text.slice(0, READING.mention)));
  assert.match(s, pointer(READING.mention, text));
});
