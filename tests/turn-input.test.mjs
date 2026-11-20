// What a turn is given (designs/rooms-at-scale.md, “What a turn is given” and “The budget”): server/turn-input.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryLine, tailOf, turnInput } from '../server/turn-input.mjs';
import { READING, TURN_INPUT } from '../shared/limits.mjs';

const at = Date.UTC(2026, 10, 15, 14, 2);
const texts = { it_881: 'Is the index kept current?', it_890: 'Ship it on Friday.' };
const read = (/** @type {string} */ id) => texts[id] ?? null;
const topic = { id: 'th_12', kind: 'topic', title: 'Search index' };
const mention = { id: 'en_1', threadId: 'th_12', itemId: 'it_881', source: 'mention', from: 'critic', at };
const person = { id: 'en_2', threadId: 'th_12', itemId: 'it_890', source: 'person', from: 'you', at: at + 180_000 };

test('a turn’s entries come whole, oldest first, with where the reply posts', () => {
  const text = turnInput({ entries: [mention, person], thread: topic, read });
  assert.equal(
    text,
    [
      '[Postbox] 2 messages for you in the thread “Search index” (th_12). Your reply posts there.',
      '[it_881] @critic, 14:02 UTC: Is the index kept current?',
      '[it_890] The person, 14:05 UTC: Ship it on Friday.',
    ].join('\n\n'),
  );
});

test('entries waiting in other threads are counted, and the conversation and a room are named', () => {
  const one = turnInput({ entries: [mention], thread: { id: 'th_1', kind: 'chat' }, read, waitingElsewhere: 1 });
  assert.match(
    one,
    /^\[Postbox\] 1 message for you in this conversation\. Your reply posts there and goes back to @critic\. @-mention another agent to hand off to them instead\. 1 more waits in another thread, and starts your next turn\./,
  );
  const two = turnInput({ entries: [person], thread: { id: 'th_1', kind: 'room' }, read, waitingElsewhere: 2 });
  assert.match(two, /for you in this room\. Your reply posts there\. 2 more wait in other threads, and start your next turn\./);
});

test('#1518, #1523 where the reply goes: back to agents whose mentions alone started the turn, a reply that came back included', () => {
  const head = (/** @type {any[]} */ entries) => turnInput({ entries, thread: { id: 'th_1', kind: 'chat' }, read }).split('\n\n')[0];
  const other = { ...mention, id: 'en_3', itemId: 'it_882', from: 'researcher' };
  assert.match(head([mention, other]), /Your reply posts there and goes back to @critic and @researcher\. @-mention another agent/);
  assert.match(head([{ ...mention, bounce: true }]), /Your reply posts there and goes back to @critic\. @-mention another agent/);
  // With the person’s message, or what isn’t a mention, it goes where it @-mentions only, as before.
  assert.match(head([mention, person]), /Your reply posts there\.$/);
  assert.match(head([mention, { ...mention, id: 'en_4', source: 'check', from: undefined }]), /Your reply posts there\.$/);
});

test('an entry past the ceiling for one entry is cut, with the id that reads the rest', () => {
  const long = 'x'.repeat(READING.mention + 500);
  const line = entryLine(mention, () => long);
  assert.ok(line.includes(`${'x'.repeat(READING.mention)}… (15,000 of 15,500 characters; read_message { id: "it_881" } has the rest)`));
  assert.ok(!line.includes('x'.repeat(READING.mention + 1)));
});

test('each source says what it is: a review, an answer, a scheduled wake, a command, a check, an event, a notice', () => {
  const of = (/** @type {object} */ e) => entryLine({ id: 'en_9', threadId: 'th_1', at, ...e }, read);
  assert.equal(of({ source: 'review', from: 'critic', itemId: 'it_881' }), '[it_881] @critic, a review of your block, 14:02 UTC: Is the index kept current?');
  assert.equal(of({ source: 'answer', from: 'you', itemId: 'it_890' }), '[it_890] The person, an answer to what you showed, 14:02 UTC: Ship it on Friday.');
  assert.equal(of({ source: 'scheduled', text: 'Check the build.' }), '[en_9] Postbox, the wake you scheduled, 14:02 UTC: Check the build.');
  assert.equal(
    of({ source: 'command', from: 'you', text: 'Summarize this topic thread.' }),
    '[en_9] The person, a command, 14:02 UTC: Summarize this topic thread.',
  );
  assert.equal(of({ source: 'check', text: 'Two problems.' }), '[en_9] Postbox, a check of your work, 14:02 UTC: Two problems.');
  assert.equal(of({ source: 'event', text: 'The app sent a row.' }), '[en_9] Postbox, from an app, 14:02 UTC: The app sent a row.');
  assert.equal(of({ source: 'notice', text: '@x isn’t in this conversation.' }), '[en_9] Postbox, 14:02 UTC: @x isn’t in this conversation.');
});

test('a resend says so, newer posts from the sender are listed, and a deleted item is named as gone', () => {
  assert.equal(
    entryLine({ ...mention, resend: true, postedSince: ['it_900', 'it_901'] }, read),
    '[it_881] @critic, 14:02 UTC, sent again in case it didn’t reach you: Is the index kept current?\n(The same sender posted since: [it_900], [it_901])',
  );
  assert.equal(entryLine({ ...mention, itemId: 'it_gone' }, read), '[it_gone] @critic, 14:02 UTC: (deleted since it was sent)');
});

test('the tail keeps the newest lines within its count, and the turn says how many it left out and where they are', () => {
  const lines = Array.from({ length: 45 }, (_, i) => `[it_${i}] @developer: line ${i}`);
  const { kept, left } = tailOf(lines);
  assert.equal(kept.length, TURN_INPUT.tailItems);
  assert.equal(left, 5);
  assert.equal(kept[0], lines[5]);
  assert.equal(kept.at(-1), lines[44]);
  const text = turnInput({ entries: [mention], thread: topic, read, tail: lines });
  assert.ok(
    text.includes(
      '[Postbox] Also since your last turn, not addressed to you (the last 40 of 45 items; read_conversation has the rest in order, with thread: "th_12" for this thread’s items, and search_conversation finds one by its words):\n\n[it_5] @developer: line 5',
    ),
  );
  assert.ok(!text.includes('[it_4] @developer: line 4'));
});

test('the tail keeps within its size, and never more than fits', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `${i}${'y'.repeat(4999)}`);
  const { kept, left } = tailOf(lines);
  assert.equal(kept.length, 3);
  assert.equal(left, 7);
  assert.ok(kept.join('').length <= TURN_INPUT.tailChars);
  // One line longer than the whole tail is left out, not cut: read_conversation cut it already, so it can’t be.
  assert.deepEqual(tailOf(['z'.repeat(TURN_INPUT.tailChars + 1)]), { kept: [], left: 1 });
});

test('a whole tail has no line on what is left out, and a turn with nothing else since has no tail', () => {
  const text = turnInput({ entries: [mention], thread: topic, read, tail: ['[it_870] @developer: built it'] });
  assert.ok(text.endsWith('[Postbox] Also since your last turn, not addressed to you:\n\n[it_870] @developer: built it'));
  assert.ok(!turnInput({ entries: [mention], thread: topic, read }).includes('Also since'));
});

test('the tail carries its notes after its lines, a topic’s first message comes first, and stopped entries are listed', () => {
  const text = turnInput({
    entries: [mention],
    thread: topic,
    read,
    tail: ['[it_870] @developer: built it'],
    notes: ['The thread “Release” (th_9) has 3 new messages.'],
    root: 'This thread is about @developer’s message: the index.',
    stopped: ['it_700', 'it_701'],
  });
  const parts = text.split('\n\n');
  assert.equal(parts[0], '[Postbox] This thread is about @developer’s message: the index.');
  assert.equal(parts[3], '[Postbox] The person stopped you before a turn started from [it_700], [it_701]. read_message reads one.');
  assert.deepEqual(parts.slice(-2), ['[it_870] @developer: built it', 'The thread “Release” (th_9) has 3 new messages.']);
});

test('the tail’s notes count within its limits, so a room with many threads can’t grow a turn without bound', () => {
  const notes = Array.from({ length: 60 }, (_, i) => `The thread “T${i}” (th_${i}) has 1 new message.`);
  const text = turnInput({ entries: [mention], thread: topic, read, tail: ['[it_870] @developer: built it'], notes });
  const lines = text.split('Also since your last turn')[1].split('\n\n').slice(1);
  assert.equal(lines.length, TURN_INPUT.tailItems);
  assert.equal(lines.at(-1), notes.at(-1), 'the notes are the newest, so they are kept first');
  assert.ok(text.includes('(the last 40 of 61 items; read_conversation has the rest in order'));
});

test('a tail none of whose lines fit still says how many were left out and where they are', () => {
  const text = turnInput({ entries: [mention], thread: topic, read, tail: ['z'.repeat(TURN_INPUT.tailChars + 1)] });
  assert.ok(
    text.endsWith(
      '[Postbox] Also since your last turn, not addressed to you: 1 item, not shown here. read_conversation has it in order, with thread: "th_12" for this thread’s items, and search_conversation finds one by its words.',
    ),
  );
});

test('#675: an entry cut at the ceiling ends on a whole character, never half of an emoji', () => {
  const text = `${'x'.repeat(READING.mention - 1)}😀 and more`;
  const line = entryLine(mention, () => text);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(line), 'no lone first half of a pair');
  assert.ok(line.includes(`${'x'.repeat(READING.mention - 1)}… (`), 'the emoji goes whole to the part read_message reads');
});
