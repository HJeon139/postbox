import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicEvent, publicFrame, publicState } from '../server/public-state.mjs';
import { keepEvent } from '../server/room-events.mjs';
import { apply, EVENTS, emptyState, PRIVATE_STATE_KEYS, PUBLIC_EVENT_TYPES, PUBLIC_STATE_KEYS, RESERVED } from '../shared/state.mjs';

// The event types on main when the table was made, every one public. Adding, removing or hiding a type is a reviewed
// change to this list (designs/architecture.md, “What reaches the browser”).
const TYPES = [
  'settings',
  'project',
  'persona',
  'boilerplate',
  'thread',
  'session',
  'session.patch',
  'app',
  'file',
  'dataset',
  'schedule',
  'glossary',
  'item.add',
  'item.patch',
  'item.move',
  'item.text',
  'work.add',
  'work.patch',
  'remove',
  'notify',
  'host',
  'host.status',
  // A conversation’s assets (#516 S3): metadata only, never an asset’s contents.
  'asset',
  'asset.version',
  'asset.erase',
  'asset.released',
  // An old turn leaving the state (#305): its summary entry and its replies’ step counts, none of the moved detail.
  'turn.archive',
];

test('the event table has exactly the known types, each with a handler and a public flag, all public today', () => {
  assert.deepEqual(Object.keys(EVENTS).sort(), [...TYPES].sort());
  for (const [type, entry] of Object.entries(EVENTS)) {
    assert.equal(typeof entry.apply, 'function', type);
    assert.equal(entry.public, true, type);
  }
});

test('the page’s event types are derived from the table: every public entry, and nothing else', () => {
  assert.deepEqual(
    PUBLIC_EVENT_TYPES,
    Object.keys(EVENTS).filter((t) => EVENTS[t].public),
  );
  assert.deepEqual([...PUBLIC_EVENT_TYPES].sort(), [...TYPES].sort());
});

test('the stream’s own frame names are never event types', () => {
  assert.deepEqual([...RESERVED].sort(), ['cursor', 'epoch', 'resync', 'status']);
  for (const name of RESERVED) assert.equal(Object.hasOwn(EVENTS, name), false, name);
});

test('every key of the state is either public or private, never both and never neither', () => {
  const keys = Object.keys(emptyState());
  assert.deepEqual([...PUBLIC_STATE_KEYS, ...PRIVATE_STATE_KEYS].sort(), [...keys].sort());
  for (const k of PUBLIC_STATE_KEYS) assert.equal(PRIVATE_STATE_KEYS.includes(k), false, k);
  assert.equal(PUBLIC_STATE_KEYS.length, 19);
});

test('the public state keeps the public keys, as the store’s own values, and drops any other key', () => {
  const state = { ...emptyState(), records: { r1: { parts: [{ text: 'private words' }] } } };
  const out = publicState(state);
  assert.deepEqual(Object.keys(out), PUBLIC_STATE_KEYS);
  assert.equal(out.items, state.items, 'shallow: the same objects, no copy');
  assert.doesNotMatch(JSON.stringify(out), /private words|records/);
});

test('a public event goes to the page as it is; any other becomes a cursor with only its seq', () => {
  const ev = { seq: 4, type: 'item.add', data: { threadId: 't', item: { id: 'i' } } };
  assert.equal(publicEvent(ev), ev);
  assert.deepEqual(publicEvent({ seq: 5, type: 'no.such.type', data: { text: 'x' } }), { seq: 5, type: 'cursor', data: {} });
  const table = { ...EVENTS, secret: { apply: () => {}, public: false } };
  assert.deepEqual(publicEvent({ seq: 6, type: 'secret', data: { words: 'private' } }, table), { seq: 6, type: 'cursor', data: {} });
  assert.equal(publicFrame({ seq: 6, type: 'secret', data: { words: 'private' } }, table), 'id: 6\nevent: cursor\ndata: {}\n\n');
  assert.equal(publicFrame(ev), `id: 4\nevent: item.add\ndata: ${JSON.stringify(ev.data)}\n\n`);
});

test('the reducer refuses a type with no entry, including the names of Object’s own members', () => {
  for (const type of ['no.such.type', 'toString', '__proto__', 'cursor']) assert.throws(() => apply(emptyState(), type, {}), /Unknown store event/, type);
});

test('the table and its entries are frozen, so a type can’t change its flag at run time', () => {
  assert.equal(Object.isFrozen(EVENTS), true);
  for (const [type, entry] of Object.entries(EVENTS)) assert.equal(Object.isFrozen(entry), true, type);
});

test('telemetry keeps no event of a type the page may not see, since its reports reach the page', () => {
  const ev = { threadId: 't', item: { id: 'i', text: 'x' } };
  assert.deepEqual(keepEvent(1, 'item.add', ev), { seq: 1, type: 'item.add', data: ev });
  const table = { ...EVENTS, 'item.add': { ...EVENTS['item.add'], public: false } };
  assert.equal(keepEvent(1, 'item.add', ev, new Map(), table), null);
  assert.equal(keepEvent(2, 'no.such.type', {}), null);
});
