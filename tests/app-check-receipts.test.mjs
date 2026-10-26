// App receipts distinguish saving a version from the browser checking that version (#337).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { onStoreEvent, snapshotOf } from '../server/remote/turns-snapshot.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

function setup() {
  const store = new Store(null);
  const adapter = { name: 'mock', folderFor: async () => null, deliver: async () => {} };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p', name: 'Project', folder: '/tmp' });
  const persona = rt.createPersona({ handle: 'author' });
  const thread = rt.createThread({ projectId: 'p', title: 'Apps', personaIds: [persona.id] });
  const [session] = rt.sessionsIn(thread.id);
  return { rt, session, tools: rt.toolsFor(session.id) };
}

test('#337 saving a new version reports pending instead of claiming its check passed', () => {
  const { rt, tools } = setup();
  const first = tools.show_app({ id: 'lab', title: 'Lab', code: '<p>First</p>' });
  assert.equal(first.version, 1);
  assert.equal(first.check.status, 'pending');
  rt.appCheck('lab', { version: 1, problems: [] });
  const second = tools.update_app({ id: 'lab', code: '<p>Second</p>' });
  assert.equal(second.version, 2);
  assert.equal(second.check.status, 'pending');
});

test('#337 an agent can read the current version’s recorded check without triggering one', () => {
  const { rt, tools } = setup();
  tools.show_app({ id: 'lab', title: 'Lab', code: '<p>First</p>' });
  assert.match(tools.read_message({ id: 'lab' }).message, /v1[\s\S]*pending/);
  rt.appCheck('lab', { version: 1, problems: [] });
  assert.match(tools.read_message({ id: 'lab' }).message, /v1[\s\S]*passed/);
  tools.update_app({ id: 'lab', code: '<p>Second</p>' });
  rt.appCheck('lab', { version: 1, problems: [] });
  const current = tools.read_message({ id: 'lab' }).message;
  assert.match(current, /v2[\s\S]*pending/);
  assert.doesNotMatch(current, /passed/);
});

test('#337 recorded warnings and crashes reach readers without being called passes', () => {
  const { rt, tools } = setup();
  const receipt = tools.show_app({ id: 'lab', title: 'Lab', code: '<p>First</p>' });
  rt.appCheck('lab', { version: 1, problems: [{ code: 'marks-too-small', message: 'Tiny marks.' }] });
  const note = tools.read_message({ id: receipt.itemId }).message;
  assert.match(note, /v1[\s\S]*note[\s\S]*marks-too-small: Tiny marks/);
  tools.update_app({ id: 'lab', code: '<p>Second</p>' });
  rt.appCheck('lab', { version: 2, problems: [{ code: 'script-error', message: 'Unexpected token.' }] });
  assert.match(tools.read_message({ id: 'lab' }).message, /v2[\s\S]*crashed[\s\S]*Unexpected token/);
});

test('#337 an app check read stays inside the reader’s conversation', () => {
  const { rt, tools } = setup();
  const first = tools.show_app({ id: 'private-lab', title: 'Private lab', code: '<p>First</p>' });
  const persona = rt.createPersona({ handle: 'outsider' });
  const thread = rt.createThread({ projectId: 'p', title: 'Other conversation', personaIds: [persona.id] });
  const [outside] = rt.sessionsIn(thread.id);
  assert.equal(rt.toolsFor(outside.id).read_message({ id: 'private-lab' }).ok, false);
  assert.equal(rt.toolsFor(outside.id).read_message({ id: first.itemId }).ok, false);
});

test('#337 a browser check refreshes the reading snapshot for remote turns too', () => {
  const { rt, session, tools } = setup();
  const receipt = tools.show_app({ id: 'lab', title: 'Lab', code: '<p>First</p>' });
  const rts = {
    rt,
    live: new Map([[session.id, { sessionId: session.id }]]),
    dirty: new Map(),
    setTimer: () => ({ unref() {} }),
  };
  assert.match(snapshotOf(rts, session).threads[0].items.find((i) => i.id === receipt.itemId).text, /v1[\s\S]*pending/);
  rt.appCheck('lab', { version: 1, problems: [] });
  onStoreEvent(rts, { type: 'app', data: rt.s.apps.lab });
  assert.equal(rts.dirty.get(session.id).items.get(session.threadId).has(receipt.itemId), true);
  assert.match(snapshotOf(rts, session).threads[0].items.find((i) => i.id === receipt.itemId).text, /v1[\s\S]*passed/);
});
