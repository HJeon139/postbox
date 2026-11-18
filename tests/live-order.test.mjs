// A turn’s session frames, coalesced within a tick (server/live-buffer.mjs, liveFlush), never reorder against what
// must follow them: a stored write of the session, a commit point, the turn’s end and a Stop each send the waiting
// frame first. A stored write of a live field is taken when it’s made, so one held behind a commit can’t undo a newer
// live value. And the turn’s end puts its live fields back to what’s stored, so a page shows no subagents or glimpse
// after it, and each stream forgets the turn’s steps (designs/architecture/live-progress.md, “Which wins”).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveEnd, liveSession, liveSnapshots, liveStep } from '../server/live-buffer.mjs';
import { committed } from '../server/live-sent.mjs';
import { liveStreams } from '../server/live-streams.mjs';
import { sessionPatch } from '../server/session-patch.mjs';
import { Store } from '../server/store.mjs';
import { sendLive, sessionWriting } from '../server/store-live.mjs';
import { liveApplier } from '../shared/live-apply.mjs';
import { apply } from '../shared/state.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** A running turn on `store`, with Sessions.update as it is: the write hook first, then the event. @param {any} store */
function turnOn(store) {
  const turn = { id: 'tu_1', sessionId: 'se_1', threadId: 'th_1', first: 'it_1', live: null };
  const update = (/** @type {string} */ id, /** @type {any} */ p, /** @type {any} */ before) => {
    const data = sessionPatch(store.pending.session(id), { ...p, updatedAt: 5 });
    before?.(data);
    sessionWriting(store, data, p);
    store.emit('session.patch', data);
  };
  const running = { all: () => (turn.live ? [turn] : []), turnOf: (/** @type {string} */ id) => (id === turn.sessionId ? turn : undefined) };
  return { turn, rt: { store, s: store.state, sessions: { update }, running } };
}

/** A page’s stream: its frames in order, as [event, data], and its state as it applies them from what it loaded. */
function page(live, store, query = '&open=th_1') {
  /** @type {string[]} */
  const frames = [];
  const res = { writeHead() {}, write: (/** @type {string} */ s) => frames.push(s) && true, destroy() {}, once() {} };
  const url = new URL(`http://x/api/stream?since=${store.state.seq}&epoch=${encodeURIComponent(store.epoch)}${query}`);
  live.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), url);
  const loaded = structuredClone(store.state);
  frames.length = 0;
  const order = () =>
    frames
      .join('')
      .split('\n\n')
      .map((f) => /event: (\S+)\ndata: (.*)/s.exec(f))
      .filter((m) => m && m[1] !== 'header')
      .map((m) => [m?.[1], JSON.parse(m?.[2] ?? '{}')]);
  const state = () => {
    const s = structuredClone(loaded);
    const applier = liveApplier();
    for (const [type, data] of order()) {
      if (type === 'live') applier.apply(s, data, () => true);
      else if (type === 'session.patch' || type === 'item.patch') apply(s, type, data);
    }
    return s.sessions.se_1;
  };
  return { order, state, res };
}

const tick = () => new Promise((r) => setImmediate(r));

test('after a turn ends, and after Stop, the page shows no subagents and no glimpse', async () => {
  for (const how of ['end', 'stop']) {
    const store = await new Store(null).load();
    // As turn-run.mjs leaves a session when a turn starts: no glimpse and no subagents, stored.
    store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'think', glimpse: '', subagents: [], currentStep: 'Thinking' });
    const { turn, rt } = turnOn(store);
    const live = liveStreams(store, undefined, { running: rt.running });
    try {
      const p = page(live, store);
      liveSession(rt, turn, { glimpse: 'Reading the shelf', subagents: [{ id: 'a', name: 'helper', state: 'tool' }] });
      await tick();
      assert.equal(p.state().glimpse, 'Reading the shelf', 'live while it runs');
      liveEnd(rt, turn); // turn-finish.mjs and stop-record.mjs, both
      // The edge’s write, as turn-needs.mjs and turn-stop.mjs make it: the same '' and [] as stored, so not stored again.
      if (how === 'stop') rt.sessions.update('se_1', { state: 'stopping', subagents: [], glimpse: '', currentStep: 'Stopping' });
      else rt.sessions.update('se_1', { state: 'idle', glimpse: '', subagents: [], currentStep: 'Idle' });
      await tick();
      const se = p.state();
      assert.deepEqual([se.glimpse, se.subagents], ['', []], how);
    } finally {
      live.stop();
    }
  }
});

test('a stored write held behind a commit is taken when it’s made: a newer live value made after it wins', async () => {
  const h = await heldStore();
  const { store } = h;
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'tool', currentStep: '' });
  await store.flush();
  const { turn, rt } = turnOn(store);
  liveSession(rt, turn, { currentStep: 'Read' });
  h.hold();
  const commit = store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  rt.sessions.update('se_1', { currentStep: 'Waiting for you' }); // stored, held
  liveSession(rt, turn, { currentStep: 'Bash' }); // newer, live
  h.release();
  await commit;
  await store.flush();
  assert.equal(liveSnapshots(rt)[0].session.currentStep, 'Bash');
  await store.close();
});

test('a coalesced session frame goes before a stored write right after it, a commit point, the turn’s end and a Stop', async () => {
  const store = await new Store(null).load();
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'tool', currentStep: '' });
  const { turn, rt } = turnOn(store);
  const live = liveStreams(store, undefined, { running: rt.running });
  try {
    const p = page(live, store);
    // A tool’s stream gets every stored event whole, so the order of each against the frames shows.
    const tool = page(live, store, '');
    const kinds = () =>
      tool
        .order()
        .map(([type, d]) =>
          type === 'live' ? `${d.kind}:${d.currentStep ?? d.step?.id ?? ''}` : `${type}:${d.patch?.currentStep ?? d.activityStep?.id ?? ''}`,
        );
    // A stored write right after a coalesced change.
    liveSession(rt, turn, { currentStep: 'Read' });
    rt.sessions.update('se_1', { currentStep: 'Waiting for you' });
    assert.deepEqual(kinds(), ['session:Read', 'session.patch:Waiting for you']);
    // A commit point: a new step of the agent’s own stores the one before it.
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' });
    liveSession(rt, turn, { currentStep: 'Edit' });
    liveStep(rt, turn, { id: 's2', label: 'Edit', state: 'running' });
    assert.deepEqual(kinds().slice(2), ['step:s1', 'session:Edit', 'item.patch:s1', 'step:s2']);
    // The turn’s end, and the Stop that ends it: its waiting frame, then its last commit point.
    liveSession(rt, turn, { currentStep: 'Bash' });
    liveEnd(rt, turn);
    rt.sessions.update('se_1', { state: 'stopping', currentStep: 'Stopping' });
    const tail = kinds().slice(6);
    assert.deepEqual(tail.slice(0, 2), ['session:Bash', 'item.patch:s2']);
    assert.equal(tail.at(-1), 'session.patch:Stopping');
    assert.equal(p.state().currentStep, 'Stopping');
  } finally {
    live.stop();
  }
});

test('a turn’s end clears its steps from every stream’s record: a later commit point of one goes to the page whole', async () => {
  const store = await new Store(null).load();
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'tool' });
  const { turn, rt } = turnOn(store);
  const live = liveStreams(store, undefined, { running: rt.running });
  try {
    const p = page(live, store);
    liveStep(rt, turn, { id: 's1', label: 'Read', state: 'running' });
    // Its commit point held behind a commit is released from its JSON, unmarked: the page’s record of s1 would stay.
    sendLive(store, { kind: 'end', threadId: 'th_1', itemId: 'it_1' });
    const data = { threadId: 'th_1', id: 'it_1', activityStep: { id: 's1', state: 'done' } };
    committed.add(data);
    store.emit('item.patch', data);
    assert.deepEqual(
      p
        .order()
        .filter(([t]) => t === 'item.patch')
        .map(([, d]) => d.activityStep.id),
      ['s1'],
      'forgotten at the end, so not spared',
    );
  } finally {
    live.stop();
  }
});

test('Stop mid-turn clears the subagents on a connected page and in the snapshot, though none were ever stored', async () => {
  const store = await new Store(null).load();
  // As a turn starts: no subagents stored, and none until it ends.
  store.emit('session', { id: 'se_1', threadId: 'th_1', state: 'tool', subagents: [], currentStep: '' });
  const { turn, rt } = turnOn(store);
  const live = liveStreams(store, undefined, { running: rt.running });
  try {
    const p = page(live, store);
    liveSession(rt, turn, { subagents: [{ id: 'a', name: 'helper', state: 'tool' }], currentStep: 'Agent' });
    await tick();
    assert.equal(p.state().subagents.length, 1, 'live while it runs');
    // turn-stop.mjs, mid-turn: the same [] as stored, which sessionPatch leaves out of the event.
    rt.sessions.update('se_1', { state: 'stopping', subagents: [], currentStep: 'Stopping', stopAsk: null });
    assert.deepEqual(liveSnapshots(rt)[0].session.subagents, [], 'a page that loads now');
    await tick();
    assert.deepEqual(p.state().subagents, [], 'a page that was connected');
    assert.equal(p.state().currentStep, 'Stopping');
  } finally {
    live.stop();
  }
});
