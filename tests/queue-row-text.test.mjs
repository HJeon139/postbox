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

const answer = entry('answer', { message: { kind: 'notice', text: '[Postbox] The person allowed `npm test` for your next turn only.' } });

test('your answer to a card names the card by its title', () => {
  const card = { id: 'it_1', kind: 'block', block: { id: 'frames', type: 'confirm', title: 'Delete the video frames?', fallback: 'Delete?' } };
  assert.equal(queuedText(entry('answer'), card), 'Your answer to “Delete the video frames?”');
});

test('your answer to an untitled card names it by its fallback, not its id', () => {
  const card = { id: 'it_1', kind: 'block', block: { id: 'q_region_2', type: 'choice', fallback: 'Which region first?' } };
  assert.equal(queuedText(entry('answer'), card), 'Your answer to “Which region first?”');
});

test('an answer whose card the page hasn’t loaded has no text yet, for the queue to fetch the card', () => {
  assert.equal(queuedText(answer, undefined), null);
  assert.equal(placeholderText(answer), 'Your answer.');
});

test('a permission answer says what you allowed, not the notice written to the agent', () => {
  const card = { id: 'it_1', kind: 'denial', handle: 'builder', summary: 'run npm test', status: 'allowed-once', rules: { alwaysWords: 'npm test' } };
  assert.equal(queuedText(answer, card), 'You allowed @builder once to run npm test');
  assert.equal(queuedText(answer, { ...card, status: 'allowed-always' }), 'You always allowed npm test: @builder to run npm test');
});

test('a tool, browser or wake card’s answer says what you chose', () => {
  assert.equal(queuedText(answer, { kind: 'toolask', handle: 'builder', label: 'GitHub', status: 'on' }), 'You turned on “GitHub” for @builder');
  assert.equal(queuedText(answer, { kind: 'toolask', handle: 'builder', label: 'GitHub', status: 'off' }), 'You kept “GitHub” off for @builder');
  assert.equal(queuedText(answer, { kind: 'viewask', handle: 'builder', status: 'declined' }), 'You chose not to download the browser for @builder’s app');
  assert.equal(queuedText(answer, { kind: 'viewask', handle: 'builder', status: 'ready' }), 'You allowed the browser download for @builder’s app');
  assert.equal(queuedText(answer, { kind: 'hop', from: 'critic', to: 'builder', status: 'declined' }), 'You didn’t allow @critic to wake @builder');
  assert.equal(
    queuedText(answer, { kind: 'hop', join: true, from: 'critic', to: 'builder', status: 'declined' }),
    'You didn’t add @builder to this conversation',
  );
});

test('an app’s event reads as the line it posted in your voice, and says it’s your app’s while that line comes', () => {
  assert.equal(
    queuedText(entry('event'), { id: 'it_1', kind: 'voice', text: 'Picked “Lisbon” in Trip planner', appId: 'ap_1' }),
    'Picked “Lisbon” in Trip planner',
  );
  assert.equal(placeholderText(entry('event')), 'An event from your app.');
});

test('a review names its block and who reviewed it, once the block comes', () => {
  const e = entry('review', { from: 'critic', message: { kind: 'event', event: { blockId: 'draft', action: 'review' } } });
  assert.equal(queuedText(e, { id: 'it_1', kind: 'block', block: { id: 'draft', title: 'Launch plan' } }), '@critic’s review of “Launch plan”');
  assert.equal(queuedText(e, undefined), null);
  assert.equal(placeholderText(e), 'A review from @critic.');
});

test('a message’s placeholder says whose it is', () => {
  assert.equal(placeholderText(entry('person')), 'Your message.');
  assert.equal(placeholderText(entry('mention', { from: 'critic' })), 'A message from @critic.');
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
  const of = (source) => entry(source, source === 'review' ? { from: 'critic' } : {});
  for (const source of SOURCES)
    for (const item of [undefined, { id: 'it_1', kind: 'block', block: { id: 'b', title: 'A card' } }]) {
      const e = of(source);
      const text = queuedText(e, item) ?? placeholderText(e);
      assert.ok(!text.includes('@you'), `${source}: ${text}`);
    }
});
