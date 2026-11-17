// What of a live frame reaches the browser (designs/architecture/live-progress.md, “What reaches the browser”;
// security-boundaries.md): each kind mirrors an event type and takes that type’s public flag from EVENTS, so the two
// can’t drift; a frame carries only its kind’s listed fields; and an item’s frames go only to a stream that has its
// conversation open. Nothing is sent on the frame yet: this holds the projection before anything is.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicLive, publicLiveFrame } from '../server/public-state.mjs';
import { LIVE, STEP_FIELDS } from '../shared/live-kinds.mjs';
import { EVENTS, STREAM } from '../shared/state.mjs';

/** The frame’s data as the page would get it, or null when it goes out as nothing. @param {string} frame */
const dataOf = (frame) => {
  if (!frame) return null;
  assert.match(frame, /^event: live\ndata: .*\n\n$/s);
  return JSON.parse(frame.slice('event: live\ndata: '.length, -2));
};

/** EVENTS with one type made private, as a spec would. @param {string} type */
const privateTable = (type) => ({ ...EVENTS, [type]: { ...EVENTS[type], public: false } });

const SECRET = { secret: 'held by the server only', token: 'x' };
const step = { id: 's1', label: 'Read', state: 'running', at: 12, part: 0, input: 'ls', ...SECRET };
const frames = {
  text: { kind: 'text', threadId: 'th_1', itemId: 'it_1', turnId: 'tu_1', at: 0, text: 'Hello', ...SECRET },
  step: { kind: 'step', threadId: 'th_1', itemId: 'it_1', turnId: 'tu_1', rev: 2, step, ...SECRET },
  session: { kind: 'session', sessionId: 'se_1', toolCalls: [], toolCount: 1, currentStep: 'Read', glimpse: 'g', subagents: [], ...SECRET },
  snapshot: {
    kind: 'snapshot',
    turnId: 'tu_1',
    sessionId: 'se_1',
    threadId: 'th_1',
    itemId: 'it_1',
    text: { at: 0, text: 'Hello', ...SECRET },
    steps: [step],
    session: { currentStep: 'Read', glimpse: 'g', ...SECRET },
    ...SECRET,
  },
};

test('the live frame’s name is the stream’s own, never an event type', () => {
  assert.equal(STREAM.live, 'live');
  assert.equal(Object.hasOwn(EVENTS, 'live'), false);
});

test('each kind mirrors event types that exist, and takes its public flag from EVENTS', () => {
  for (const [kind, def] of Object.entries(LIVE)) {
    assert.ok(def.events.length, kind);
    for (const type of def.events) assert.ok(Object.hasOwn(EVENTS, type), `${kind} mirrors ${type}`);
    assert.ok(dataOf(publicLiveFrame(frames[kind])), `${kind} goes out while its events are public`);
    for (const type of def.events) assert.equal(publicLiveFrame(frames[kind], null, privateTable(type)), '', `${kind} with ${type} private`);
  }
});

test('a kind with no entry, or one whose event type isn’t in EVENTS, goes out as nothing', () => {
  assert.equal(publicLiveFrame({ kind: 'thinking', threadId: 'th_1', text: 'x' }), '');
  assert.equal(publicLiveFrame({ kind: 'toString' }), '');
  const { 'item.text': _, ...without } = EVENTS;
  assert.equal(publicLiveFrame(frames.text, null, /** @type {any} */ (without)), '');
});

test('a frame carries only its kind’s fields, a step only its step fields, and a snapshot only theirs', () => {
  for (const [kind, f] of Object.entries(frames)) {
    const d = dataOf(publicLiveFrame(f));
    assert.ok(!JSON.stringify(d).includes('held by the server only'), kind);
    for (const k of Object.keys(d)) assert.ok(k === 'kind' || LIVE[kind].fields.includes(k), `${kind}.${k}`);
  }
  const s = dataOf(publicLiveFrame(frames.step)).step;
  for (const k of Object.keys(s)) assert.ok(STEP_FIELDS.includes(k), `step.${k}`);
  assert.deepEqual(dataOf(publicLiveFrame(frames.step)).step, { id: 's1', label: 'Read', state: 'running', at: 12, part: 0, input: 'ls' });
  const snap = dataOf(publicLiveFrame(frames.snapshot));
  assert.deepEqual(snap.text, { at: 0, text: 'Hello' });
  assert.deepEqual(snap.session, { currentStep: 'Read', glimpse: 'g' });
  for (const k of Object.keys(snap.steps[0])) assert.ok(STEP_FIELDS.includes(k), `snapshot step.${k}`);
});

test('an item’s frames go only to a stream with its conversation open; a session’s go to every stream', () => {
  const open = new Set(['th_other']);
  for (const kind of ['text', 'step', 'snapshot']) {
    assert.equal(publicLiveFrame(frames[kind], open), '', `${kind} to a stream without its conversation`);
    assert.ok(dataOf(publicLiveFrame(frames[kind], new Set(['th_1']))), `${kind} to one with it`);
    assert.ok(dataOf(publicLiveFrame(frames[kind], null)), `${kind} to a tool’s stream, which names none`);
  }
  assert.ok(dataOf(publicLiveFrame(frames.session, open)));
});

test('publicLive gives the snapshots a page may have, by the same rules', () => {
  const other = { ...frames.snapshot, threadId: 'th_2', turnId: 'tu_2' };
  const got = publicLive([frames.snapshot, other], new Set(['th_1']));
  assert.deepEqual(
    got.map((s) => s.turnId),
    ['tu_1'],
  );
  assert.ok(!JSON.stringify(got).includes('held by the server only'));
  assert.deepEqual(publicLive([frames.snapshot], null, privateTable('session.patch')), []);
});
