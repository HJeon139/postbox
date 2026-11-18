// A running reply’s words go live (server/live-text.mjs; designs/architecture/live-progress.md, “Commit points”): each
// delta goes to the pages as a text frame with `at`, where its words start in the part’s text, and the words are stored
// only at a commit point, as one item.text with `at`: a step of the agent’s own, the part settling, LIVE_TEXT.everyMs
// with no commit, LIVE_TEXT.most of words, or the turn’s end. The reducer applies a stored chunk or a frame once,
// whatever the page already has of it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveEnd, liveSnapshots, liveStep } from '../server/live-buffer.mjs';
import { liveText } from '../server/live-text.mjs';
import { Store } from '../server/store.mjs';
import { itemSettling, onLive } from '../server/store-live.mjs';
import { LIVE_TEXT } from '../shared/limits.mjs';
import { apply, emptyState } from '../shared/state.mjs';

/** A store, a running turn with one part on it, what it stores of the words and the frames it sends. */
async function rig() {
  const store = await new Store(null).load();
  store.emit('item.add', { threadId: 'th_1', item: { id: 'it_1', kind: 'agent', text: '', status: 'streaming' } });
  /** @type {any[]} */
  const stored = [];
  /** @type {any[]} */
  const frames = [];
  store.subscribe((/** @type {any} */ ev) => ev.type === 'item.text' && stored.push(ev.data));
  onLive(store, (f) => frames.push(f));
  const turn = { id: 'tu_1', sessionId: 'se_1', threadId: 'th_1', first: 'it_1', partWords: {}, live: null, liveText: null };
  const rt = { store, running: { all: () => [turn], turnOf: () => turn }, sessions: { update() {} } };
  /** The turn’s words, as turn-context.mjs reports them. @param {string} delta @param {string} [part] */
  const say = (delta, part = 'it_1') => {
    const at = turn.partWords[part] ?? 0;
    turn.partWords[part] = at + delta.length;
    liveText(rt, turn, part, at, delta);
  };
  const text = () => store.state.items.th_1.find((/** @type {any} */ x) => x.id === 'it_1').text;
  return { store, rt, turn, stored, frames, say, text };
}

test('words go live with where they start, and aren’t stored until a step of the agent’s own', async () => {
  const { rt, turn, stored, frames, say, text } = await rig();
  say('Reading ');
  say('the shelf.');
  assert.deepEqual(
    frames.filter((f) => f.kind === 'text').map((f) => [f.at, f.text]),
    [
      [0, 'Reading '],
      [8, 'the shelf.'],
    ],
  );
  assert.deepEqual(stored, [], 'nothing stored yet');
  assert.equal(text(), '');
  liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' });
  assert.deepEqual(stored, [{ threadId: 'th_1', id: 'it_1', text: 'Reading the shelf.', at: 0 }], 'one item.text, at its start');
  assert.equal(text(), 'Reading the shelf.');
  say(' Done.');
  liveEnd(rt, turn);
  assert.deepEqual(stored.at(-1), { threadId: 'th_1', id: 'it_1', text: ' Done.', at: 18 }, 'the rest at the turn’s end');
  assert.equal(text(), 'Reading the shelf. Done.');
});

test('a part’s words are stored before the patch that settles it, so item.final reads them whole', async () => {
  const { store, stored, say } = await rig();
  say('Hello @critic, ');
  say('take a look.');
  /** @type {string[]} */
  const order = [];
  store.subscribe((/** @type {any} */ ev) => order.push(ev.type));
  // threads.mjs, patchItem, for a patch that settles a streaming reply: the hook, then the event.
  itemSettling(store, 'th_1', 'it_1');
  store.emit('item.patch', { threadId: 'th_1', id: 'it_1', patch: { status: 'done' } });
  assert.deepEqual(order, ['item.text', 'item.patch']);
  assert.equal(stored[0].text, 'Hello @critic, take a look.');
});

test('words are stored after LIVE_TEXT.everyMs with no commit point, and early at LIVE_TEXT.most', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stored, say } = await rig();
  say('Thinking aloud');
  t.mock.timers.tick(LIVE_TEXT.everyMs - 1);
  assert.deepEqual(stored, []);
  t.mock.timers.tick(1);
  assert.equal(stored.length, 1, 'stored on time');
  say('x'.repeat(LIVE_TEXT.most));
  assert.equal(stored.length, 2, 'stored at the size cap, without waiting');
  assert.equal(stored[1].at, 'Thinking aloud'.length);
});

test('a running turn’s snapshot carries its words since the last commit point, with their part and start', async () => {
  const { rt, turn, say } = await rig();
  say('First words.');
  liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' }); // a commit point
  say(' Then more.');
  const [snap] = liveSnapshots(rt);
  assert.deepEqual(snap.text, { at: 'First words.'.length, text: ' Then more.' }, 'its part is the snapshot’s own, so it isn’t named twice');
  say('Below the post.', 'it_2'); // words in a later part, as after a post lands below the reply
  assert.deepEqual(liveSnapshots(rt)[0].text, { itemId: 'it_2', at: 0, text: 'Below the post.' });
});

test('the reducer applies words once: a chunk the item already has, or has part of, adds only what it lacks', () => {
  const s = emptyState();
  apply(s, 'item.add', { threadId: 'th_1', item: { id: 'it_1', kind: 'agent', text: '' } });
  const text = () => s.items.th_1[0].text;
  apply(s, 'item.text', { threadId: 'th_1', id: 'it_1', text: 'Reading ', at: 0 });
  apply(s, 'item.text', { threadId: 'th_1', id: 'it_1', text: 'the shelf.', at: 8 });
  // The commit point of both, after the page had them live: nothing more.
  apply(s, 'item.text', { threadId: 'th_1', id: 'it_1', text: 'Reading the shelf.', at: 0 });
  assert.equal(text(), 'Reading the shelf.');
  // A chunk that overlaps what it has: only its tail.
  apply(s, 'item.text', { threadId: 'th_1', id: 'it_1', text: 'shelf. Done.', at: 12 });
  assert.equal(text(), 'Reading the shelf. Done.');
  // Without `at`, as a shell run’s output: appended, as ever.
  apply(s, 'item.text', { threadId: 'th_1', id: 'it_1', text: '!' });
  assert.equal(text(), 'Reading the shelf. Done.!');
});
