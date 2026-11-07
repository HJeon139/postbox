import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, EVENTS, emptyState, map, patchSession } from '../shared/state.mjs';

// The reducer as it was before the event table (main at 88af074f), so the table can be shown to apply every type
// exactly as the switch did. It's a transcription, not the original text: split in three to fit the length limit, and
// checked case by case against the deleted switch. It's frozen here on purpose: change the table, not this.
function switchApply(s, type, d) {
  if (type.startsWith('item.')) return switchItems(s, type, d);
  if (LATER.has(type)) return switchLater(s, type, d);
  switch (type === 'session.patch' ? 'session' : type) {
    case 'settings':
      Object.assign(s.settings, d);
      break;
    case 'project':
      s.projects[d.id] = d;
      break;
    case 'persona':
      s.personas[d.id] = d;
      break;
    case 'boilerplate':
      delete s.boilerplates[d.id];
      s.boilerplates[d.id] = d;
      break;
    case 'thread':
      s.threads[d.id] = d;
      break;
    case 'session':
      if (type === 'session') s.sessions[d.id] = d;
      else if (s.sessions[d.id]) s.sessions[d.id] = patchSession(s.sessions[d.id], d);
      break;
    case 'app':
      s.apps[d.id] = d;
      break;
    case 'file':
      s.files[d.id] = d;
      break;
    case 'dataset':
      (s.datasets ??= map())[d.id] = d;
      break;
    case 'schedule':
      if (d.removed) delete s.schedules[d.id];
      else s.schedules[d.id] = d;
      break;
    case 'glossary':
      (s.glossary[d.threadId] ??= map())[d.entry.key] = d.entry;
      break;
    default:
      throw new Error(`Unknown store event “${type}”.`);
  }
}

// The switch's item cases, split out only to keep each function under the length limit.
function switchItems(s, type, d) {
  switch (type) {
    case 'item.add':
      (s.items[d.threadId] ??= []).push(d.item);
      break;
    case 'item.patch': {
      const it = s.items[d.threadId]?.find((i) => i.id === d.id);
      if (it) {
        if (d.activityStep) {
          const steps = (it.activity ??= { steps: [] }).steps;
          const index = steps.findIndex((step) => step.id === d.activityStep.id);
          if (index < 0) steps.push(d.activityStep);
          else steps[index] = { ...steps[index], ...d.activityStep };
        }
        if (d.patch) Object.assign(it, d.patch);
      }
      break;
    }
    case 'item.move': {
      const list = s.items[d.threadId];
      const i = list?.findIndex((x) => x.id === d.id) ?? -1;
      if (i < 0) break;
      const [it] = list.splice(i, 1, d.stub);
      list.push(Object.assign(it, d.patch));
      break;
    }
    case 'item.text': {
      const it = s.items[d.threadId]?.find((i) => i.id === d.id);
      if (it) it.text = (it.text ?? '') + d.text;
      break;
    }
    default:
      throw new Error(`Unknown store event “${type}”.`);
  }
}

const LATER = new Set(['work.add', 'work.patch', 'remove', 'notify', 'host', 'host.status']);

// Its remaining cases, and the host events its default case passed to applyHost.
function switchLater(s, type, d) {
  switch (type) {
    case 'work.add':
      ((s.work ??= map())[d.convId] ??= []).push(d.entry);
      break;
    case 'work.patch': {
      const e = s.work?.[d.convId]?.find((x) => x.id === d.id);
      if (e) Object.assign(e, d.patch);
      break;
    }
    case 'remove': {
      if (d.kind === 'thread') {
        delete s.threads[d.id];
        delete s.items[d.id];
        delete s.glossary[d.id];
        if (s.work) delete s.work[d.id];
      }
      const kept = { session: 'sessions', app: 'apps', persona: 'personas' }[d.kind];
      if (kept) delete s[kept][d.id];
      break;
    }
    case 'notify':
      break;
    default:
      if (type === 'host') {
        if (d.removed) {
          delete s.hosts?.[d.id];
          delete s.hostStatus?.[d.id];
        } else (s.hosts ??= Object.create(null))[d.id] = d;
      } else if (type === 'host.status') {
        if (d.status === null) delete s.hostStatus?.[d.id];
        else (s.hostStatus ??= Object.create(null))[d.id] = d.status;
      } else throw new Error(`Unknown store event “${type}”.`);
  }
}

const ev = (type, data) => ({ type, data });
const item = (id, text = id) => ev('item.add', { threadId: 't1', item: { id, text } });
// Each case: the events that set the state up, then the event under test, applied to a fresh state by both reducers.
const CASES = [
  ['settings', [], ev('settings', { theme: 'dark' })],
  ['project', [], ev('project', { id: 'p1', name: 'P' })],
  ['persona', [], ev('persona', { id: 'pe1', handle: 'a' })],
  ['boilerplate', [ev('boilerplate', { id: 'b1', text: 'x' }), ev('boilerplate', { id: 'b2', text: 'y' })], ev('boilerplate', { id: 'b1', text: 'z' })],
  ['thread', [], ev('thread', { id: 't1', title: 'T' })],
  ['session', [], ev('session', { id: 's1', status: 'idle' })],
  ['session.patch', [ev('session', { id: 's1', status: 'idle', x: 1 })], ev('session.patch', { id: 's1', patch: { status: 'busy' }, unset: ['x'] })],
  ['session.patch on a session that’s gone', [], ev('session.patch', { id: 's9', patch: { status: 'busy' } })],
  ['app', [], ev('app', { id: 'a1' })],
  ['file', [], ev('file', { id: 'f1' })],
  ['dataset', [], ev('dataset', { id: 'd1' })],
  ['schedule', [], ev('schedule', { id: 'sc1', at: 1 })],
  ['schedule removed', [ev('schedule', { id: 'sc1', at: 1 })], ev('schedule', { id: 'sc1', removed: true })],
  ['glossary', [], ev('glossary', { threadId: 't1', entry: { key: 'k', text: 'v' } })],
  ['item.add', [], item('i1')],
  ['item.patch', [item('i1')], ev('item.patch', { threadId: 't1', id: 'i1', patch: { text: 'b' } })],
  [
    'item.patch with an activity step',
    [item('i1'), ev('item.patch', { threadId: 't1', id: 'i1', activityStep: { id: 'st1', label: 'a' } })],
    ev('item.patch', { threadId: 't1', id: 'i1', activityStep: { id: 'st1', done: true } }),
  ],
  ['item.patch on an item that’s gone', [], ev('item.patch', { threadId: 't1', id: 'i9', patch: { text: 'b' } })],
  ['item.move', [item('i1'), item('i2')], ev('item.move', { threadId: 't1', id: 'i1', stub: { id: 'stub1', kind: 'stub' }, patch: { moved: true } })],
  ['item.move of an item that’s gone', [item('i1')], ev('item.move', { threadId: 't1', id: 'i9', stub: { id: 'stub9' } })],
  ['item.text', [item('i1', 'a')], ev('item.text', { threadId: 't1', id: 'i1', text: '+b' })],
  ['work.add', [], ev('work.add', { convId: 't1', entry: { id: 'w1' } })],
  ['work.patch', [ev('work.add', { convId: 't1', entry: { id: 'w1' } })], ev('work.patch', { convId: 't1', id: 'w1', patch: { done: true } })],
  [
    'remove a thread',
    [ev('thread', { id: 't1' }), item('i1'), ev('glossary', { threadId: 't1', entry: { key: 'k' } }), ev('work.add', { convId: 't1', entry: { id: 'w1' } })],
    ev('remove', { kind: 'thread', id: 't1' }),
  ],
  ['remove a session', [ev('session', { id: 's1' })], ev('remove', { kind: 'session', id: 's1' })],
  ['remove an app', [ev('app', { id: 'a1' })], ev('remove', { kind: 'app', id: 'a1' })],
  ['remove a persona', [ev('persona', { id: 'pe1' })], ev('remove', { kind: 'persona', id: 'pe1' })],
  ['notify', [], ev('notify', { text: 'hi' })],
  ['host', [], ev('host', { id: 'h1', name: 'x' })],
  ['host removed', [ev('host', { id: 'h1' }), ev('host.status', { id: 'h1', status: { state: 'up' } })], ev('host', { id: 'h1', removed: true })],
  ['host.status', [], ev('host.status', { id: 'h1', status: { state: 'up' } })],
  ['host.status cleared', [ev('host.status', { id: 'h1', status: { state: 'up' } })], ev('host.status', { id: 'h1', status: null })],
];

test('the event table applies every type exactly as the switch did', () => {
  for (const [name, setup, last] of CASES) {
    const before = emptyState();
    const after = emptyState();
    // Each reducer gets its own copy of the data: item.move changes the item it moves, which is the data item.add put.
    for (const e of [...setup, last]) {
      switchApply(before, e.type, structuredClone(e.data));
      apply(after, e.type, structuredClone(e.data));
    }
    assert.deepEqual(after, before, name);
    // And in the same key order, which is what a boilerplate's re-add changes.
    assert.equal(JSON.stringify(after), JSON.stringify(before), name);
  }
});

// The switch knew only the types on main at 88af074f, so it speaks for those. A type added since has its own reducer
// tests: the asset events (#516 S3) in tests/state-assets.test.mjs, and turn.archive (#305) in tests/state-archive.test.mjs.
const ADDED_SINCE = ['asset', 'asset.version', 'asset.erase', 'asset.released', 'turn.archive'];

test('the cases cover every type the switch knew, so a type of its time needs one', () => {
  const covered = new Set(CASES.map(([, , last]) => last.type));
  assert.deepEqual(
    [...covered].sort(),
    Object.keys(EVENTS)
      .filter((t) => !ADDED_SINCE.includes(t))
      .sort(),
  );
});
