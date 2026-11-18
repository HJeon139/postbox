// What of a live frame reaches the browser (designs/architecture/live-progress.md, “What reaches the browser”;
// security-boundaries.md): each kind mirrors event types and takes their public flag from EVENTS, and needs the state
// keys its data belongs to public, so neither can drift; a frame carries only its kind’s shape, nested values picked
// by their own lists and only scalars kept; and an item’s frames go only to a stream that has its conversation open.
// Nothing is sent on the frame yet: this holds the projection before anything is.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicLive, publicLiveFrame } from '../server/public-state.mjs';
import { LIVE, SESSION_FIELDS, STEP_FIELDS, SUBAGENT_FIELDS, TOOL_CALL_FIELDS } from '../shared/live-kinds.mjs';
import { EVENTS, PRIVATE_STATE_KEYS, PUBLIC_STATE_KEYS, STREAM } from '../shared/state.mjs';

/** The frame’s data as the page would get it, or null when it goes out as nothing. @param {string} frame */
const dataOf = (frame) => {
  if (!frame) return null;
  assert.match(frame, /^event: live\ndata: .*\n\n$/s);
  return JSON.parse(frame.slice('event: live\ndata: '.length, -2));
};

/** EVENTS with one type made private, as a spec would. @param {string} type */
const privateTable = (type) => ({ ...EVENTS, [type]: { ...EVENTS[type], public: false } });
/** The public state keys without one. @param {string} key */
const withoutKey = (key) => PUBLIC_STATE_KEYS.filter((k) => k !== key);

const SECRET = 'held by the server only';
const hide = { secret: SECRET, deep: { secret: SECRET } };
const step = { id: 's1', label: 'Read', state: 'running', at: 12, part: 'p1', input: 'ls', ...hide };
const session = {
  toolCalls: [{ name: 'Read', state: 'done', ms: 3, ...hide }],
  toolCount: 1,
  currentStep: 'Read',
  glimpse: 'g',
  subagents: [{ id: 'a1', name: 'helper', state: 'tool', doing: 'Reading', ...hide }],
};
const frames = {
  text: { kind: 'text', threadId: 'th_1', itemId: 'it_1', turnId: 'tu_1', at: 0, text: 'Hello', ...hide },
  step: { kind: 'step', threadId: 'th_1', itemId: 'it_1', turnId: 'tu_1', rev: 2, step, ...hide },
  session: { kind: 'session', sessionId: 'se_1', ...session, ...hide },
  snapshot: {
    kind: 'snapshot',
    turnId: 'tu_1',
    sessionId: 'se_1',
    threadId: 'th_1',
    itemId: 'it_1',
    text: { at: 0, text: 'Hello', ...hide },
    steps: [step],
    session: { ...session, ...hide },
    ...hide,
  },
};

test('the live frame’s name is the stream’s own, never an event type', () => {
  assert.equal(STREAM.live, 'live');
  assert.equal(Object.hasOwn(EVENTS, 'live'), false);
});

test('the shapes are these, so a field added to one is a decision this test sees', () => {
  assert.deepEqual(STEP_FIELDS, [
    'id',
    'label',
    'state',
    'ms',
    'who',
    'parent',
    'detail',
    'kind',
    'job',
    'input',
    'output',
    'part',
    'at',
    'added',
    'deleted',
    'diff',
  ]);
  assert.deepEqual(TOOL_CALL_FIELDS, ['name', 'state', 'ms']);
  assert.deepEqual(SUBAGENT_FIELDS, ['id', 'name', 'state', 'ctx', 'doing', 'thinking', 'asked', 'said', 'since', 'parent', 'bg']);
  assert.deepEqual(SESSION_FIELDS, ['toolCalls', 'toolCount', 'currentStep', 'glimpse', 'subagents']);
  assert.deepEqual(Object.keys(LIVE), ['text', 'step', 'session', 'snapshot']);
  assert.deepEqual(LIVE.text.shape.fields, ['threadId', 'itemId', 'at', 'text']);
  assert.deepEqual(LIVE.step.shape.fields, ['threadId', 'itemId', 'rev']);
  assert.deepEqual(Object.keys(LIVE.step.shape.objects ?? {}), ['step']);
  assert.deepEqual(LIVE.session.shape.fields, ['sessionId', 'toolCount', 'currentStep', 'glimpse', 'state', 'ctx', 'updatedAt']);
  assert.deepEqual(Object.keys(LIVE.session.shape.lists ?? {}), ['toolCalls', 'subagents']);
  assert.deepEqual(LIVE.snapshot.shape.fields, ['turnId', 'sessionId', 'threadId', 'itemId']);
  assert.deepEqual(Object.keys(LIVE.snapshot.shape.objects ?? {}), ['text', 'session']);
  assert.deepEqual(LIVE.snapshot.shape.objects?.text.fields, ['itemId', 'at', 'text']);
  assert.deepEqual(Object.keys(LIVE.snapshot.shape.lists ?? {}), ['steps']);
});

test('each kind takes its public flag from EVENTS: any of its event types made private, it goes out as nothing', () => {
  for (const [kind, def] of Object.entries(LIVE)) {
    for (const type of def.events) assert.ok(Object.hasOwn(EVENTS, type), `${kind} mirrors ${type}`);
    assert.ok(dataOf(publicLiveFrame(frames[kind])), `${kind} goes out while its events are public`);
    for (const type of def.events) assert.equal(publicLiveFrame(frames[kind], null, privateTable(type)), '', `${kind} with ${type} private`);
  }
});

test('an item’s kinds need items public, and a session’s need sessions public', () => {
  for (const kind of ['text', 'step', 'snapshot']) assert.equal(publicLiveFrame(frames[kind], null, EVENTS, withoutKey('items')), '', `${kind} without items`);
  for (const kind of ['session', 'snapshot']) assert.equal(publicLiveFrame(frames[kind], null, EVENTS, withoutKey('sessions')), '', `${kind} without sessions`);
  assert.ok(dataOf(publicLiveFrame(frames.text, null, EVENTS, withoutKey('sessions'))), 'text needs only items');
  assert.ok(dataOf(publicLiveFrame(frames.session, null, EVENTS, withoutKey('items'))), 'session needs only sessions');
});

test('a kind with no entry, or one whose event type isn’t in EVENTS, goes out as nothing', () => {
  assert.equal(publicLiveFrame({ kind: 'thinking', threadId: 'th_1', text: 'x' }), '');
  assert.equal(publicLiveFrame({ kind: 'toString' }), '');
  const { 'item.text': _, ...without } = EVENTS;
  assert.equal(publicLiveFrame(frames.text, null, /** @type {any} */ (without)), '');
});

test('a frame carries only its shape, all the way down: no nested value gets past its own list', () => {
  for (const [kind, f] of Object.entries(frames)) assert.ok(!JSON.stringify(dataOf(publicLiveFrame(f))).includes(SECRET), kind);
  assert.deepEqual(dataOf(publicLiveFrame(frames.step)).step, { id: 's1', label: 'Read', state: 'running', at: 12, part: 'p1', input: 'ls' });
  assert.deepEqual(dataOf(publicLiveFrame(frames.session)), {
    kind: 'session',
    sessionId: 'se_1',
    toolCount: 1,
    currentStep: 'Read',
    glimpse: 'g',
    toolCalls: [{ name: 'Read', state: 'done', ms: 3 }],
    subagents: [{ id: 'a1', name: 'helper', state: 'tool', doing: 'Reading' }],
  });
  const snap = dataOf(publicLiveFrame(frames.snapshot));
  assert.deepEqual(snap.text, { at: 0, text: 'Hello' });
  assert.deepEqual(snap.session.toolCalls, [{ name: 'Read', state: 'done', ms: 3 }]);
  assert.deepEqual(snap.steps, [{ id: 's1', label: 'Read', state: 'running', at: 12, part: 'p1', input: 'ls' }]);
});

test('a listed field given an object or a list where a scalar belongs is dropped, not sent whole', () => {
  const objects = { secret: SECRET };
  const t = dataOf(publicLiveFrame({ ...frames.text, text: objects, at: [objects] }));
  assert.equal(t.text, undefined);
  assert.equal(t.at, undefined);
  const s = dataOf(publicLiveFrame({ ...frames.step, rev: objects, step: { ...step, input: objects, label: [SECRET] } }));
  assert.equal(s.rev, undefined);
  assert.deepEqual(s.step, { id: 's1', state: 'running', at: 12, part: 'p1' });
  const se = dataOf(publicLiveFrame({ ...frames.session, toolCalls: objects, subagents: [objects, 'x', null] }));
  assert.equal(se.toolCalls, undefined, 'a list that isn’t one goes');
  assert.deepEqual(se.subagents, [{}], 'an entry that isn’t an object goes; one that is keeps its listed fields');
  assert.ok(!JSON.stringify([t, s, se]).includes(SECRET));
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

test('an open that isn’t a Set sends nothing, whatever it holds', () => {
  // Not given at all, it’s null, a tool’s stream; anything given must be a Set.
  for (const open of [['th_1'], ['th_other'], { th_1: true }, 'th_1', 0, false])
    for (const kind of Object.keys(frames)) assert.equal(publicLiveFrame(frames[kind], /** @type {any} */ (open)), '', `${kind} with ${JSON.stringify(open)}`);
});

test('publicLive gives the snapshots a page may have, by the same rules, reading each entry as a snapshot', () => {
  const other = { ...frames.snapshot, threadId: 'th_2', turnId: 'tu_2' };
  // A buffer entry that names another kind, or none, is still a snapshot here: one named a session would skip open.
  const misnamed = { ...frames.snapshot, kind: 'session', threadId: 'th_3', turnId: 'tu_3' };
  const unnamed = { ...frames.snapshot, kind: undefined, turnId: 'tu_4' };
  const got = publicLive([frames.snapshot, other, misnamed, unnamed], new Set(['th_1']));
  assert.deepEqual(
    got.map((s) => [s.kind, s.turnId]),
    [
      ['snapshot', 'tu_1'],
      ['snapshot', 'tu_4'],
    ],
  );
  assert.ok(!JSON.stringify(got).includes(SECRET));
  assert.deepEqual(publicLive([frames.snapshot], null, privateTable('session.patch')), []);
  assert.deepEqual(publicLive([frames.snapshot], null, EVENTS, withoutKey('items')), []);
});

test('a field a frame only inherits is never sent, at any level', () => {
  const inherit = (/** @type {any} */ proto, /** @type {any} */ own) => Object.assign(Object.create(proto), own);
  const se = dataOf(publicLiveFrame(inherit({ glimpse: SECRET, currentStep: SECRET }, { kind: 'session', sessionId: 'se_1' })));
  assert.deepEqual(se, { kind: 'session', sessionId: 'se_1' });
  const st = dataOf(publicLiveFrame({ ...frames.step, step: inherit({ input: SECRET }, { id: 's1', label: 'Read' }) }));
  assert.deepEqual(st.step, { id: 's1', label: 'Read' });
  const snap = dataOf(publicLiveFrame({ ...frames.snapshot, session: inherit({ toolCalls: [{ name: SECRET }] }, { glimpse: 'g' }) }));
  assert.deepEqual(snap.session, { glimpse: 'g' });
});

test('no kind mirrors a private event or names a private state key: published (#1478) never rides a live frame', () => {
  for (const [kind, def] of Object.entries(LIVE)) {
    assert.deepEqual(
      def.keys.filter((k) => PRIVATE_STATE_KEYS.includes(k)),
      [],
      `${kind} names a private key`,
    );
    assert.ok(
      def.events.every((t) => Object.hasOwn(EVENTS, t) && EVENTS[t].public),
      `${kind} mirrors a private event`,
    );
    assert.ok(!def.events.includes('app.publish'), kind);
  }
  // A kind that named the private key would go out as nothing: the gate reads the public keys.
  assert.ok(PRIVATE_STATE_KEYS.includes('published') && !PUBLIC_STATE_KEYS.includes('published'));
  // And a published app’s data put on a frame of any kind is dropped by its shape.
  for (const f of Object.values(frames)) {
    const out = dataOf(publicLiveFrame({ ...f, published: { app: { data: SECRET } } }));
    assert.equal(JSON.stringify(out).includes(SECRET), false);
  }
});
