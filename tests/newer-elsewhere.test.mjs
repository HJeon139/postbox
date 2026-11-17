// #734: what a turn’s prompt says as it starts (newerElsewhere, server/newer-waiting.mjs): each message from a sender
// of the entries it takes that waits in another thread and is newer than that sender’s newest it takes, at most three,
// then a count, as a tool result’s notes are (MOST_NOTES).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newerElsewhere } from '../server/newer-waiting.mjs';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';

/** The room, a topic in it, and a way to leave beta an entry from a sender, in a thread, at a time. */
function room() {
  const f = setup();
  const root = arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  const wait = (/** @type {string} */ from, /** @type {string} */ threadId, /** @type {number} */ at) =>
    f.rt.delivery.send({ sessionId: f.beta.id, threadId, source: 'mention', text: `From ${from} at ${at}.`, from, at }, { wake: false });
  return { ...f, topic, wait, title: f.rt.s.threads[topic].title };
}
/** What beta’s turn in the conversation is told, taking alpha’s message of time 1000 there. @param {any} f */
const told = (f) => newerElsewhere(f.rt, f.beta.id, f.t.id, [{ from: 'alpha', at: 1000, threadId: f.t.id }]);

test('#734 the prompt names only the sender’s newer message in another thread', () => {
  const f = room();
  f.wait('gamma', f.topic, 2000);
  f.wait('alpha', f.t.id, 2000);
  f.wait('alpha', f.topic, 500);
  f.wait('alpha', f.topic, 2000);
  const notes = told(f);
  assert.equal(notes.filter((n) => n.includes('from @gamma')).length, 0, 'not another sender’s');
  assert.equal(notes.filter((n) => !n.includes(` in “${f.title}”`)).length, 0, 'not one in the turn’s own thread, which comes next');
  assert.equal(notes.length, 1, 'not an older one, which the sender already followed');
  assert.match(notes[0], /^\[Postbox\] A newer message from @alpha is waiting for you in “/);
});

test('#734 the prompt names at most three, then counts the rest', () => {
  const f = room();
  for (const n of [1, 2, 3, 4, 5, 6]) f.wait('alpha', f.topic, 2000 + n);
  const notes = told(f);
  assert.equal(notes.length, 4);
  assert.equal(notes.filter((n) => n.startsWith('[Postbox] A newer message from @alpha')).length, 3);
  assert.equal(notes[3], '[Postbox] 3 more newer messages are waiting for you in other threads; each starts a turn of its own after this one.');
});
