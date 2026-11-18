// A stored event a page had live isn’t sent to it (server/live-sent.mjs; designs/architecture/live-progress.md,
// “Commit points”): a commit point of a step it was sent live, or a running turn’s change of state, which rides on the
// session frame. So each change crosses the wire once. A page that opened its stream after the step went live, or
// doesn’t have the conversation open, and a tool’s stream, get the stored event as before.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveEnd, liveSession, liveStep, liveUpdate } from '../server/live-buffer.mjs';
import { liveStreams } from '../server/live-streams.mjs';
import { sessionPatch } from '../server/session-patch.mjs';
import { Store } from '../server/store.mjs';
import { sessionWriting } from '../server/store-live.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/**
 * A stream on `live`, and the frames written to it after it opened, by event name; from `since`, its backlog too, as a
 * page that reconnects with its Last-Event-ID gets it.
 */
function open(live, store, query, since = /** @type {number | null} */ (null)) {
  /** @type {string[]} */
  const frames = [];
  const res = { writeHead() {}, write: (/** @type {string} */ s) => frames.push(s) && true, destroy() {}, once() {} };
  const url = new URL(`http://x/api/stream?since=${since ?? store.state.seq}&epoch=${encodeURIComponent(store.epoch)}${query}`);
  live.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), url);
  if (since === null) frames.length = 0;
  const events = () =>
    frames
      .join('')
      .split('\n\n')
      .map((f) => /^id: \d+\nevent: (\S+)\ndata: (.*)$/m.exec(f))
      .filter(Boolean)
      .map((m) => [m?.[1], JSON.parse(m?.[2] ?? '{}').activityStep?.id]);
  /** The live session frames. */
  const sessions = () =>
    frames
      .join('')
      .split('\n\n')
      .filter((f) => f.startsWith('event: live\n'))
      .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)))
      .filter((d) => d.kind === 'session');
  return { events, sessions };
}

test('a commit point isn’t sent to a page that had the step live, and goes whole to the rest', async () => {
  const store = await new Store(null).load();
  const live = liveStreams(store, undefined, { running: { all: () => [] } });
  try {
    const turn = { id: 'tu_1', sessionId: 'se_1', threadId: 'th_1', first: 'it_1' };
    const rt = { store, sessions: { update() {} } };
    const before = open(live, store, '&open=th_1');
    const elsewhere = open(live, store, '&open=th_2');
    const tool = open(live, store, '');
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' });
    const after = open(live, store, '&open=th_1');
    liveEnd(rt, turn);
    assert.deepEqual(before.events(), [], 'had it live');
    assert.deepEqual(after.events(), [['item.patch', 's1']], 'opened after it went live');
    assert.deepEqual(elsewhere.events(), [['cursor', undefined]], 'not open: a cursor, as any item’s event');
    assert.deepEqual(tool.events(), [['item.patch', 's1']], 'a tool reads the stored events whole');
    // Any other patch of the step, after its commit point, goes whole.
    store.emit('item.patch', { threadId: 'th_1', id: 'it_1', activityStep: { id: 's1', state: 'stopped' } });
    assert.deepEqual(before.events().at(-1), ['item.patch', 's1']);
  } finally {
    live.stop();
  }
});

test('a running turn’s change of state is stored, rides on its session frame, and isn’t sent to a page again', async () => {
  const store = await new Store(null).load();
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'gen' });
  const live = liveStreams(store, undefined, { running: { all: () => [] } });
  try {
    const { turn, rt } = turnOn(store);
    const page = open(live, store, '&open=th_1');
    const tool = open(live, store, '');
    liveSession(rt, turn, { glimpse: 'Looking' }); // the page has had the session’s frames
    liveUpdate(rt, turn, { state: 'tool', currentStep: 'Read' });
    await null; // the end of the tick, which sends the turn’s session frame
    assert.equal(store.state.sessions.se_1.state, 'tool', 'stored');
    assert.deepEqual(page.events(), []);
    assert.deepEqual(page.sessions().at(-1), { kind: 'session', sessionId: 'se_1', currentStep: 'Read', state: 'tool', updatedAt: 5 });
    assert.deepEqual(tool.events(), [['session.patch', undefined]], 'a tool reads the stored event whole');
    // The same state again stores nothing: no write of updatedAt alone.
    const seq = store.state.seq;
    liveUpdate(rt, turn, { state: 'tool', currentStep: 'Read a.md' });
    await null;
    assert.equal(store.state.seq, seq);
    assert.deepEqual(page.sessions().at(-1), { kind: 'session', sessionId: 'se_1', currentStep: 'Read a.md' });
  } finally {
    live.stop();
  }
});

test('the turn’s end stores its tool calls, which the pages had live, and doesn’t send them again', async () => {
  const store = await new Store(null).load();
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'tool' });
  const live = liveStreams(store, undefined, { running: { all: () => [] } });
  try {
    const { turn, rt } = turnOn(store);
    const page = open(live, store, '&open=th_1');
    const tool = open(live, store, '');
    liveSession(rt, turn, { toolCalls: [{ name: 'Read', state: 'done' }], toolCount: 1 });
    liveEnd(rt, turn);
    assert.equal(store.state.sessions.se_1.toolCount, 1, 'stored');
    assert.deepEqual(page.events(), [], 'had them live');
    assert.deepEqual(tool.events(), [['session.patch', undefined]]);
  } finally {
    live.stop();
  }
});

/** A turn on `store`, with what its live buffer needs of a runtime: writes of the session through the store. */
function turnOn(store) {
  const turn = { id: 'tu_1', sessionId: 'se_1', threadId: 'th_1', first: 'it_1' };
  const update = (/** @type {string} */ id, /** @type {any} */ p, /** @type {any} */ before) => {
    const data = sessionPatch(store.pending.session(id), { ...p, updatedAt: 5 });
    before?.(data);
    sessionWriting(store, data, p); // as Sessions.update does: the turn’s waiting frame goes first
    store.emit('session.patch', data);
  };
  const running = { all: () => [turn], turnOf: (/** @type {string} */ sid) => (sid === turn.sessionId ? turn : undefined) };
  return { turn, rt: { store, s: store.state, sessions: { update }, running } };
}

test('a page that reconnects gets the events it was spared again, whole, in its backlog: its place never moved past them', async () => {
  const store = await new Store(null).load();
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'gen' });
  const live = liveStreams(store, undefined, { running: { all: () => [] } });
  try {
    const { turn, rt } = turnOn(store);
    const page = open(live, store, '&open=th_1');
    const placed = store.state.seq; // the last seq the page was sent: its Last-Event-ID
    liveSession(rt, turn, { glimpse: 'Looking' });
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' });
    liveUpdate(rt, turn, { state: 'tool', currentStep: 'Read' });
    liveEnd(rt, turn);
    assert.deepEqual(page.events(), [], 'spared all three');
    const again = open(live, store, '&open=th_1', placed);
    assert.deepEqual(again.events(), [
      ['session.patch', undefined],
      ['item.patch', 's1'],
    ]);
  } finally {
    live.stop();
  }
});

test('a tab mid-backlog gets the stored events whole, and is spared only what was sent it live after it joined', async () => {
  const store = await new Store(null).load();
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'gen' });
  const live = liveStreams(store, undefined, { running: { all: () => [] } });
  try {
    const { turn, rt } = turnOn(store);
    const from = store.state.seq;
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' });
    liveStep(rt, turn, { id: 's2', label: 'Edit', state: 'running' }); // a commit point: s1 is stored
    // A tab that joins now, from before s1 was stored: its backlog has the commit point whole.
    const tab = open(live, store, '&open=th_1', from);
    assert.deepEqual(tab.events(), [['item.patch', 's1']]);
    // s2 went live before the tab joined, so its commit point goes to the tab whole; s3 it had live, so it’s spared.
    liveStep(rt, turn, { id: 's3', label: 'Test', state: 'running' });
    liveEnd(rt, turn);
    assert.deepEqual(tab.events(), [
      ['item.patch', 's1'],
      ['item.patch', 's2'],
    ]);
  } finally {
    live.stop();
  }
});

test('a commit point held behind a commit in flight goes to every page whole, after the commit it waited on', async () => {
  const h = await heldStore();
  const { store } = h;
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'gen' });
  await store.flush();
  const live = liveStreams(store, undefined, { running: { all: () => [] } });
  try {
    const { turn, rt } = turnOn(store);
    const page = open(live, store, '&open=th_1');
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' });
    h.hold();
    const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
    liveEnd(rt, turn); // its commit point is held: released later, from its JSON, as an event of its own
    assert.deepEqual(page.events(), [], 'held');
    h.release();
    await commit;
    await store.flush();
    assert.deepEqual(page.events(), [
      ['settings', undefined],
      ['item.patch', 's1'],
    ]);
  } finally {
    live.stop();
    await store.close();
  }
});

test('a page that was never sent a session’s frames gets its carried change whole: marks are per stream', async () => {
  const store = await new Store(null).load();
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'gen' });
  const live = liveStreams(store, undefined, { running: { all: () => [] } });
  try {
    const { turn, rt } = turnOn(store);
    const page = open(live, store, '&open=th_1');
    liveUpdate(rt, turn, { state: 'tool' });
    assert.deepEqual(page.events(), [['session.patch', undefined]]);
    liveUpdate(rt, turn, { state: 'gen' });
    assert.deepEqual(page.events().length, 1, 'sent the frame that carried the first, it’s spared the next');
  } finally {
    live.stop();
  }
});
