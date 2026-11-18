// A running reply’s words, in windows (server/live-text.mjs; designs/architecture/live-progress.md, “Text in
// windows”): a turn holds its deltas and stores them as one item.text when its window of LIVE_TEXT.windowMs ends, and
// stores them early before a step, before the part settles, when the words go to another part, and at its end.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveEnd, liveStep } from '../server/live-buffer.mjs';
import { liveText } from '../server/live-text.mjs';
import { Store } from '../server/store.mjs';
import { itemSettling } from '../server/store-live.mjs';
import { LIVE_TEXT } from '../shared/limits.mjs';

/** A store, a running turn writing one reply, and the item.text events it stores. */
async function rig() {
  const store = await new Store(null).load();
  store.emit('item.add', { threadId: 'th_1', item: { id: 'it_1', kind: 'agent', text: '', status: 'streaming' } });
  /** @type {any[]} */
  const stored = [];
  /** @type {string[]} */
  const order = [];
  store.subscribe((/** @type {any} */ ev) => {
    order.push(ev.type);
    if (ev.type === 'item.text') stored.push([ev.data.id, ev.data.text]);
  });
  const turn = { id: 'tu_1', sessionId: 'se_1', threadId: 'th_1', first: 'it_1', partWords: {}, live: null, liveText: null };
  const rt = { store, running: { all: () => [turn], turnOf: () => turn }, sessions: { update() {} } };
  const say = (/** @type {string} */ delta, part = 'it_1') => liveText(rt, turn, part, delta);
  const text = (id = 'it_1') => store.state.items.th_1.find((/** @type {any} */ x) => x.id === id)?.text;
  return { store, rt, turn, stored, order, say, text };
}

test('a turn’s words are stored once a window, as one item.text, not one a word', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stored, say, text } = await rig();
  say('Reading ');
  say('the ');
  say('shelf.');
  assert.deepEqual(stored, [], 'held for the window');
  t.mock.timers.tick(LIVE_TEXT.windowMs);
  assert.deepEqual(stored, [['it_1', 'Reading the shelf.']]);
  say(' Three books.');
  t.mock.timers.tick(LIVE_TEXT.windowMs - 1);
  assert.equal(stored.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(stored.at(-1), ['it_1', ' Three books.'], 'the next window');
  assert.equal(text(), 'Reading the shelf. Three books.');
});

test('the words held are stored before a step, so its place among them reads right', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { rt, turn, order, say, text } = await rig();
  say('Let me look.');
  liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running', at: 'Let me look.'.length });
  assert.equal(text(), 'Let me look.', 'stored before the step went out');
  assert.equal(order.at(-1), 'item.text');
});

test('the words held for a reply are stored before the patch that settles it, so item.final reads them whole', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, order, say, text } = await rig();
  say('Over to you, @critic.');
  // threads.mjs, patchItem, for a patch that settles a streaming reply: the hook, then the event.
  itemSettling(store, 'th_1', 'it_1');
  store.emit('item.patch', { threadId: 'th_1', id: 'it_1', patch: { status: 'done' } });
  assert.deepEqual(order.slice(-2), ['item.text', 'item.patch']);
  assert.equal(text(), 'Over to you, @critic.');
});

test('words going to another part store those held first, and the turn’s end stores the rest', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, rt, turn, stored, say } = await rig();
  store.emit('item.add', { threadId: 'th_1', item: { id: 'it_2', kind: 'agent', text: '', status: 'streaming' } });
  say('Above the post.');
  say('Below it.', 'it_2');
  assert.deepEqual(stored, [['it_1', 'Above the post.']]);
  liveEnd(rt, turn);
  assert.deepEqual(stored.at(-1), ['it_2', 'Below it.']);
  assert.equal(turn.liveText, null, 'nothing held');
  t.mock.timers.tick(LIVE_TEXT.windowMs);
  assert.equal(stored.length, 2, 'nothing more once it ended');
});
