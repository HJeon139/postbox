// What a row of an agent’s queue says (app/js/queue-row-text.mjs): what is waiting, by the entry’s source and what it
// points at, never “A message from @you.” for the person’s own action.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeholderText, queuedText } from '../app/js/queue-row-text.mjs';
import { SOURCES } from '../server/delivery.mjs';

const entry = (source, more = {}) => ({ id: 'en_1', sessionId: 's1', threadId: 't1', source, itemId: 'it_1', from: 'you', state: 'waiting', ...more });

test('your message reads as its text', () => {
  assert.equal(queuedText(entry('person'), { id: 'it_1', kind: 'user', text: 'check the second table' }), 'check the second table');
});

test('an agent’s mention reads as its message', () => {
  assert.equal(queuedText(entry('mention', { from: 'critic' }), { id: 'it_1', kind: 'agent', text: 'Look at the totals.' }), 'Look at the totals.');
});

test('a slash command reads as the command you ran, without its item', () => {
  const e = entry('command', { message: { kind: 'user', text: '/review src', slash: true } });
  assert.equal(queuedText(e, undefined), '/review src');
});

test('your answer to a card names the card', () => {
  const e = entry('answer', { message: { kind: 'event', event: { blockId: 'frames', action: 'confirm' }, blockItemId: 'it_1' } });
  const card = { id: 'it_1', kind: 'block', block: { id: 'frames', type: 'confirm', title: 'Delete the video frames?' } };
  assert.equal(queuedText(e, card), 'Your answer to “Delete the video frames?”');
});

test('your answer to a card the page hasn’t loaded names it by its block’s id', () => {
  const e = entry('answer', { message: { kind: 'event', event: { blockId: 'frames', action: 'confirm' }, blockItemId: 'it_1' } });
  assert.equal(queuedText(e, undefined), 'Your answer to “frames”');
});

test('your answer to a question names the question', () => {
  const e = entry('answer', { message: { kind: 'event', event: { blockId: 'q1', action: 'submit' }, blockItemId: 'it_1' } });
  assert.equal(
    queuedText(e, { id: 'it_1', kind: 'block', question: true, block: { id: 'q1', type: 'form', title: 'Which region?' } }),
    'Your answer to “Which region?”',
  );
});

test('a permission or consent answer reads as its notice, without the Postbox tag', () => {
  const e = entry('answer', { message: { kind: 'notice', text: '[Postbox] The person allowed `npm test` for your next turn only.' } });
  assert.equal(queuedText(e, undefined), 'The person allowed `npm test` for your next turn only.');
});

test('an app’s event reads as the line it posted in your voice', () => {
  assert.equal(
    queuedText(entry('event'), { id: 'it_1', kind: 'voice', text: 'Picked “Lisbon” in Trip planner', appId: 'ap_1' }),
    'Picked “Lisbon” in Trip planner',
  );
});

test('a review names its block and who reviewed it', () => {
  const e = entry('review', { from: 'critic', message: { kind: 'event', event: { blockId: 'draft', action: 'review' } } });
  assert.equal(queuedText(e, { id: 'it_1', kind: 'block', block: { id: 'draft', title: 'Launch plan' } }), '@critic’s review of “Launch plan”');
  assert.equal(queuedText(e, undefined), '@critic’s review of “draft”');
});

test('an entry with its own text reads as that text', () => {
  for (const source of ['check', 'scheduled', 'notice', 'command', 'person'])
    assert.equal(queuedText({ ...entry(source), itemId: undefined, text: 'Summarize this thread' }, undefined), 'Summarize this thread');
});

test('a message whose item the page hasn’t loaded has no text yet, for the queue to fetch', () => {
  for (const source of ['person', 'mention', 'event']) assert.equal(queuedText(entry(source), undefined), null, source);
});

test('no entry of yours reads as a message from @you, before or after its item comes', () => {
  // A review is the one entry an agent sends without a mention: its from is the reviewer.
  const of = (source) => {
    if (source === 'answer') return entry(source, { message: { kind: 'notice', text: 'A notice.' } });
    return entry(source, source === 'review' ? { from: 'critic' } : {});
  };
  for (const source of SOURCES)
    for (const item of [undefined, { id: 'it_1', kind: 'block', block: { id: 'b', title: 'A card' } }]) {
      const e = of(source);
      const text = queuedText(e, item) ?? placeholderText(e);
      assert.ok(!text.includes('@you'), `${source}: ${text}`);
    }
});
