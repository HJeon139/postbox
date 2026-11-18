// A commit point of a running reply’s words isn’t sent to a page that was sent every one of them live
// (server/live-sent.mjs; designs/architecture/live-progress.md, “Commit points”): the stream keeps the span of each
// part’s words it was sent. A page that joined partway gets the stored words whole, and its reducer adds only what it
// lacks (shared/state.mjs, item.text’s `at`); a tool’s stream gets them whole; a turn’s end forgets the spans.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveEnd } from '../server/live-buffer.mjs';
import { liveStreams } from '../server/live-streams.mjs';
import { liveText } from '../server/live-text.mjs';
import { Store } from '../server/store.mjs';
import { liveApplier } from '../shared/live-apply.mjs';
import { apply } from '../shared/state.mjs';

/** A store with one streaming reply, a running turn writing it, and the streams. */
async function rig() {
  const store = await new Store(null).load();
  store.emit('item.add', { threadId: 'th_1', item: { id: 'it_1', kind: 'agent', text: '', status: 'streaming' } });
  const turn = { id: 'tu_1', sessionId: 'se_1', threadId: 'th_1', first: 'it_1', partWords: {}, live: null, liveText: null };
  const running = { all: () => (turn.live || turn.liveText ? [turn] : []), turnOf: () => turn };
  const rt = { store, running, sessions: { update() {} } };
  const live = liveStreams(store, undefined, { running });
  const say = (/** @type {string} */ delta) => {
    const at = turn.partWords.it_1 ?? 0;
    turn.partWords.it_1 = at + delta.length;
    liveText(rt, turn, 'it_1', at, delta);
  };
  return { store, turn, rt, live, say };
}

/** A stream on `live`, with what it was written after it opened, as a page applies it from the state it loaded. */
function open(live, store, query) {
  /** @type {string[]} */
  const frames = [];
  const res = { writeHead() {}, write: (/** @type {string} */ s) => frames.push(s) && true, destroy() {}, once() {} };
  const loaded = structuredClone(store.state);
  live.stream(
    /** @type {any} */ ({ headers: {}, on() {} }),
    /** @type {any} */ (res),
    new URL(`http://x/api/stream?since=${store.state.seq}&epoch=${encodeURIComponent(store.epoch)}${query}`),
  );
  const parsed = () =>
    frames
      .join('')
      .split('\n\n')
      .map((f) => /^(?:id: \d+\n)?event: (\S+)\ndata: (.*)$/m.exec(f))
      .filter((m) => m && m[1] !== 'header')
      .map((m) => [m?.[1], JSON.parse(m?.[2] ?? '{}')]);
  const stored = () => parsed().filter(([type]) => type === 'item.text');
  const text = () => {
    const s = structuredClone(loaded);
    const applier = liveApplier();
    for (const [type, data] of parsed()) {
      if (type === 'live') applier.apply(s, data, () => true);
      else if (type === 'item.text') apply(s, type, data);
    }
    return s.items.th_1[0].text;
  };
  return { stored, text };
}

test('a page sent every word live isn’t sent their commit point; one that joined partway, and a tool, get it whole', async () => {
  const { store, turn, rt, live, say } = await rig();
  try {
    const all = open(live, store, '&open=th_1');
    say('Reading ');
    await null; // the end of the tick, when its words go
    const late = open(live, store, '&open=th_1'); // joins with the snapshot: the words so far, then the rest live
    say('the shelf.');
    await null;
    const tool = open(live, store, '');
    liveEnd(rt, turn);
    assert.equal(store.state.items.th_1[0].text, 'Reading the shelf.');
    assert.deepEqual(all.stored(), [], 'had them all live');
    assert.deepEqual(late.stored(), [], 'the snapshot, then the rest live: all of them');
    assert.deepEqual(
      tool.stored().map(([, d]) => d.text),
      ['Reading the shelf.'],
      'a tool reads the stored words whole',
    );
    assert.equal(all.text(), 'Reading the shelf.');
    assert.equal(late.text(), 'Reading the shelf.');
  } finally {
    live.stop();
  }
});

test('a page that missed some of the words gets the commit point whole, and adds only what it lacks', async () => {
  const { store, turn, rt, live, say } = await rig();
  try {
    say('Reading ');
    await null;
    // Joins with no running turn to snapshot: the store says nothing of the words held, so the stream wasn’t sent them.
    const page = open(live, store, '&open=th_1&');
    const before = turn.liveText;
    turn.liveText = null;
    const joined = open(live, store, '&open=th_1');
    turn.liveText = before;
    say('the shelf.');
    await null;
    liveEnd(rt, turn);
    assert.deepEqual(
      joined.stored().map(([, d]) => [d.at, d.text]),
      [[0, 'Reading the shelf.']],
      'it lacked the first words, so it’s sent the whole chunk',
    );
    assert.equal(joined.text(), 'Reading the shelf.', 'added once');
    assert.deepEqual(page.stored(), []);
  } finally {
    live.stop();
  }
});
