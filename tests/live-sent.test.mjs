// A stored event a page had live isn’t sent to it (server/live-sent.mjs; designs/architecture/live-progress.md,
// “Commit points”): a commit point of a step it was sent live, or a running turn’s change of state, which rides on the
// session frame. So each change crosses the wire once. A page that opened its stream after the step went live, or
// doesn’t have the conversation open, and a tool’s stream, get the stored event as before.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveEnd, liveStep, liveUpdate } from '../server/live-buffer.mjs';
import { liveStreams } from '../server/live-streams.mjs';
import { sessionPatch } from '../server/session-patch.mjs';
import { Store } from '../server/store.mjs';

/** A stream on `live`, and the frames written to it after it opened, by event name. */
function open(live, store, query) {
  /** @type {string[]} */
  const frames = [];
  const res = { writeHead() {}, write: (/** @type {string} */ s) => frames.push(s) && true, destroy() {}, once() {} };
  const url = new URL(`http://x/api/stream?since=${store.state.seq}&epoch=${encodeURIComponent(store.epoch)}${query}`);
  live.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), url);
  frames.length = 0;
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
  const live = liveStreams(store);
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
  const live = liveStreams(store);
  try {
    const turn = { id: 'tu_1', sessionId: 'se_1', threadId: 'th_1', first: 'it_1' };
    const update = (/** @type {string} */ id, /** @type {any} */ p, /** @type {any} */ before) => {
      const data = sessionPatch(store.pending.session(id), { ...p, updatedAt: 5 });
      before?.(data);
      store.emit('session.patch', data);
    };
    const rt = { store, s: store.state, sessions: { update } };
    const page = open(live, store, '&open=th_1');
    const tool = open(live, store, '');
    liveUpdate(rt, turn, { state: 'tool', currentStep: 'Read' });
    assert.equal(store.state.sessions.se_1.state, 'tool', 'stored');
    assert.deepEqual(page.events(), []);
    assert.deepEqual(page.sessions(), [{ kind: 'session', sessionId: 'se_1', currentStep: 'Read', state: 'tool', updatedAt: 5 }]);
    assert.deepEqual(tool.events(), [['session.patch', undefined]], 'a tool reads the stored event whole');
    // The same state again stores nothing: no write of updatedAt alone.
    const seq = store.state.seq;
    liveUpdate(rt, turn, { state: 'tool', currentStep: 'Read a.md' });
    assert.equal(store.state.seq, seq);
    assert.deepEqual(page.sessions().at(-1), { kind: 'session', sessionId: 'se_1', currentStep: 'Read a.md' });
  } finally {
    live.stop();
  }
});
