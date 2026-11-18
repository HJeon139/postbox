// A page that joins a running turn by any way but a full load gets what changed since its last commit point
// (designs/architecture/live-progress.md, “A page that reconnects”): a stream sends each running turn’s live state when it
// connects, after the backlog, as its `open` lets it see it. So a conversation opened mid-turn (reopen), a side or topic
// thread opened mid-turn, a reconnect after a drop, and a stream closed for UNREAD_MS all draw the step whole and the
// session’s live fields as they are, and a reconnected page is never spared a stored event it missed live.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveEnd, liveSession, liveStep } from '../server/live-buffer.mjs';
import { liveStreams, UNREAD_MS } from '../server/live-streams.mjs';
import { sessionPatch } from '../server/session-patch.mjs';
import { Store } from '../server/store.mjs';
import { liveApplier } from '../shared/live-apply.mjs';

/** A store with a session and a reply in conversation `threadId`, a running turn on it, and the streams. */
async function rig(threadId = 'th_1', { now = () => 0 } = {}) {
  const store = await new Store(null).load();
  store.emit('thread', { id: threadId });
  store.emit('session', { id: 'se_1', threadId, state: 'tool', toolCalls: [], toolCount: 0 });
  store.emit('item.add', { threadId, item: { id: 'it_1', kind: 'agent', status: 'streaming', text: '' } });
  const turn = { id: 'tu_1', sessionId: 'se_1', threadId, first: 'it_1', live: null };
  const running = { all: () => (turn.live ? [turn] : []) };
  const update = (/** @type {string} */ id, /** @type {any} */ p, /** @type {any} */ before) => {
    const data = sessionPatch(store.pending.session(id), { ...p, updatedAt: 5 });
    before?.(data);
    store.emit('session.patch', data);
  };
  const rt = { store, s: store.state, running, sessions: { update } };
  const live = liveStreams(store, undefined, { now, running });
  return { store, turn, rt, live };
}

/** A stream on `live` from `since` (its Last-Event-ID), with what it was written, as a page applies it. */
function open(live, store, query, since = store.state.seq) {
  /** @type {string[]} */
  const frames = [];
  const res = {
    destroyed: false,
    writeHead() {},
    write: (/** @type {string} */ s) => frames.push(s) && true,
    destroy() {
      this.destroyed = true;
    },
    once() {},
  };
  live.stream(
    /** @type {any} */ ({ headers: {}, on() {} }),
    /** @type {any} */ (res),
    new URL(`http://x/api/stream?since=${since}&epoch=${encodeURIComponent(store.epoch)}${query}`),
  );
  const parts = () => frames.join('').split('\n\n').filter(Boolean);
  return {
    res,
    frames,
    numbered: () =>
      parts()
        .filter((f) => f.startsWith('id: '))
        .map((f) => /event: (\S+)\ndata: (.*)/.exec(f))
        .map((m) => [m?.[1], JSON.parse(m?.[2] ?? '{}')]),
    live: () =>
      parts()
        .filter((f) => f.startsWith('event: live\n'))
        .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6))),
  };
}

/** The page’s state after a stream’s frames, from the published state it loaded. @param {any} store @param {any} page */
function drawn(state, page) {
  const s = structuredClone(state);
  const applier = liveApplier();
  for (const [type, data] of page.numbered()) if (type === 'session.patch') s.sessions[data.id] = { ...s.sessions[data.id], ...data.patch };
  for (const f of page.live()) applier.apply(s, f, () => true);
  return s;
}

const steps = (/** @type {any} */ s, threadId = 'th_1') => s.items[threadId][0].activity?.steps ?? [];

test('a conversation opened mid-step gets the step whole, then its changes: it draws its label and input', async () => {
  const { store, turn, rt, live } = await rig();
  try {
    liveStep(rt, turn, { id: 's1', label: 'Run the tests', state: 'running', input: 'npm test' });
    const loaded = structuredClone(store.state); // what the page loaded: nothing of s1 stored
    const page = open(live, store, '&open=th_1'); // reopen
    liveStep(rt, turn, { id: 's1', label: 'Run the tests', state: 'done', ms: 900, output: 'ok' });
    const [s1] = steps(drawn(loaded, page));
    assert.equal(s1.label, 'Run the tests');
    assert.equal(s1.input, 'npm test');
    assert.equal(s1.state, 'done');
  } finally {
    live.stop();
  }
});

test('a side or topic thread opened mid-turn gets its turn’s steps; a page without it open, only the session', async () => {
  const { store, turn, rt, live } = await rig('th_side');
  try {
    liveStep(rt, turn, { id: 's1', label: 'Read the notes', state: 'running' });
    liveSession(rt, turn, { currentStep: 'Read the notes' });
    const side = open(live, store, '&open=th_side');
    const elsewhere = open(live, store, '&open=th_main');
    assert.deepEqual(
      side.live().map((f) => f.kind),
      ['snapshot'],
    );
    assert.equal(steps(drawn(store.state, side), 'th_side')[0].label, 'Read the notes');
    assert.deepEqual(elsewhere.live(), [{ kind: 'session', sessionId: 'se_1', currentStep: 'Read the notes' }], 'the rail’s session, not the steps');
  } finally {
    live.stop();
  }
});

test('a page that reconnects gets the changes it missed while away, and the final tool count after', async () => {
  const { store, turn, rt, live } = await rig();
  try {
    const first = open(live, store, '&open=th_1');
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' });
    liveSession(rt, turn, { toolCalls: [{ name: 'Read', state: 'done' }], toolCount: 1 });
    const placed = store.state.seq; // its Last-Event-ID
    const loaded = drawn(store.state, first);
    // Away: the stream dropped. Meanwhile the step ends and another call runs.
    live.streams.delete(first.res);
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'done', ms: 4 });
    liveSession(rt, turn, { toolCalls: [{ name: 'Edit', state: 'done' }], toolCount: 2 });
    const again = open(live, store, '&open=th_1', placed);
    const back = drawn(loaded, again);
    assert.equal(steps(back)[0].state, 'done', 'the step’s update made while away');
    assert.equal(back.sessions.se_1.toolCount, 2, 'the session’s, from the snapshot');
    liveEnd(rt, turn);
    assert.equal(drawn(loaded, again).sessions.se_1.toolCount, 2, 'and after the turn’s end');
  } finally {
    live.stop();
  }
});

test('a page whose stream was closed for UNREAD_MS gets the turn’s live state when it connects again', async () => {
  let now = 0;
  const { store, turn, rt, live } = await rig('th_1', { now: () => now });
  try {
    const page = open(live, store, '&open=th_1');
    // The page stops reading: every write reports the buffer full, and stays so past UNREAD_MS.
    page.res.write = (/** @type {string} */ s) => !page.frames.push(s);
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' });
    now = UNREAD_MS;
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'done', ms: 4 });
    assert.equal(page.res.destroyed, true, 'closed');
    const again = open(live, store, '&open=th_1');
    assert.equal(steps(drawn(store.state, again))[0].state, 'done');
  } finally {
    live.stop();
  }
});
