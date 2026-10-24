// Retiring an app (#193): an app its agent no longer needs shows as one line in its place, with a link to what
// replaced it and its versions. It doesn’t move, and a new version brings it back.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { TOOL_DEFS } from '../server/mcp.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

class Quiet {
  name = 'mock';
  async folderFor() {
    return null;
  }
  async deliver() {}
}

function setup() {
  const store = new Store(null);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(new Quiet()),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'researcher' });
  const b = rt.createPersona({ handle: 'critic' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id, b.id] });
  const [se, other] = rt.sessionsIn(t.id);
  return { store, rt, t, se, other, tools: rt.toolsFor(se.id), theirs: rt.toolsFor(other.id) };
}
const order = (store, t) => store.items(t.id).map((i) => (i.kind === 'block' ? i.block.id : i.kind));

test('#193: a retired app stays where it is, names who retired it and why, and leads to its replacement', () => {
  const { store, rt, t, se, tools, theirs } = setup();
  tools.show_app({ id: 'lab', title: 'Practice lab', code: '<p>1</p>' });
  tools.update_app({ id: 'lab', code: '<p>2</p>', summary: 'more exercises' });
  rt.addItem(t.id, { kind: 'user', text: 'Can we see the whole map?' });
  theirs.show_app({ id: 'critic-metro', title: 'Metro map', code: '<svg></svg>' });
  rt.addItem(t.id, { kind: 'agent', sessionId: se.id, handle: se.handle, text: 'The map replaces the lab.', status: 'done' });
  const before = order(store, t);
  const r = tools.retire_app({ id: 'lab', reason: 'The metro map covers the same ground.', replacedBy: 'critic-metro' });
  assert.equal(r.ok, true, r.message);
  // Nothing moves, and nothing is added: the app’s own place becomes its line.
  assert.deepEqual(order(store, t), before);
  const app = store.state.apps.lab;
  assert.equal(app.retired.by, 'researcher');
  assert.equal(app.retired.reason, 'The metro map covers the same ground.');
  assert.deepEqual(app.retired.replacedBy, { id: 'critic-metro', title: 'Metro map', itemId: store.state.apps['critic-metro'].itemId });
  // Its versions are kept, for its menu.
  assert.deepEqual(
    app.versions.map((v) => v.v),
    [1, 2],
  );
  assert.equal(app.current, 2);
});

test('#193: only the agent that showed an app can retire it, and replacedBy must be shown in the conversation', () => {
  const { store, tools, theirs } = setup();
  tools.show_app({ id: 'lab', title: 'Practice lab', code: '<p>1</p>' });
  tools.show_block({ block: { id: 'pick', type: 'choice', version: 1, fallback: 'x', prompt: 'Which one?', options: [{ id: 'a', label: 'A' }] } });
  assert.match(theirs.retire_app({ id: 'lab', reason: 'Mine now.' }).message, /no app with id lab from you/);
  assert.match(tools.retire_app({ id: 'lab', reason: ' ' }).message, /needs a reason/);
  assert.match(tools.retire_app({ id: 'lab', reason: 'Gone.', replacedBy: 'nowhere' }).message, /no other app or block nowhere/);
  assert.match(tools.retire_app({ id: 'lab', reason: 'Gone.', replacedBy: 'lab' }).message, /no other app or block lab/);
  assert.equal(store.state.apps.lab.retired, undefined);
  // A block can replace it too, and its prompt names it when it has no title.
  assert.equal(tools.retire_app({ id: 'lab', reason: 'Asked instead.', replacedBy: 'pick' }).ok, true);
  assert.equal(store.state.apps.lab.retired.replacedBy.title, 'Which one?');
  // Without replacedBy, it’s retired with its reason alone.
  assert.equal(tools.retire_app({ id: 'lab', reason: 'Not needed.' }).ok, true);
  assert.equal(store.state.apps.lab.retired.replacedBy, null);
});

test('#193: a new version brings a retired app back, at the newest point', () => {
  const { store, rt, t, tools } = setup();
  tools.show_app({ id: 'lab', title: 'Practice lab', code: '<p>1</p>' });
  rt.addItem(t.id, { kind: 'user', text: 'Later.' });
  tools.retire_app({ id: 'lab', reason: 'Not needed.' });
  const r = tools.update_app({ id: 'lab', code: '<p>2</p>' });
  assert.equal(r.ok, true);
  assert.equal(Object.hasOwn(store.state.apps.lab, 'retired'), false);
  assert.equal(order(store, t).at(-1), 'lab');
});

test('#193: a check still running when the app was retired is ignored, and nothing goes to the agent', () => {
  const { store, rt, tools } = setup();
  tools.show_app({ id: 'lab', title: 'Practice lab', code: '<p>1</p>' });
  tools.retire_app({ id: 'lab', reason: 'Not needed.' });
  const r = rt.appCheck('lab', { version: 1, problems: [{ code: 'contrast', message: 'Low.' }] });
  assert.deepEqual(r, { ignored: true });
  assert.equal(store.state.apps.lab.check.status, 'pending');
});

test('#193: retiring drops the sends waiting for the person, clears needs-you, and later sends are refused', () => {
  const { store, rt, t, se, tools } = setup();
  tools.show_app({ id: 'lab', title: 'Practice lab', code: '<p>1</p>' });
  rt.appEvent('lab', 'try', { n: 1 }, { hold: true });
  const card = store.items(t.id).find((x) => x.kind === 'appsend');
  assert.equal(store.state.sessions[se.id].needs?.itemId, card.id);
  tools.retire_app({ id: 'lab', reason: 'Not needed.' });
  const after = store.item(t.id, card.id);
  assert.equal(after.status, 'declined');
  assert.equal(after.retired, true);
  assert.equal(store.state.sessions[se.id].needs, null);
  assert.throws(() => rt.appEvent('lab', 'try', { n: 2 }), /Practice lab was retired, so it can’t send messages/);
});

test('#193: replacedBy names the caller’s own block when another agent’s has the same id', () => {
  const { store, tools, theirs } = setup();
  const pick = (title) => ({ block: { id: 'pick', type: 'choice', version: 1, fallback: 'x', title, options: [{ id: 'a', label: 'A' }] } });
  theirs.show_block(pick('Their question'));
  tools.show_block(pick('My question'));
  tools.show_app({ id: 'lab', title: 'Practice lab', code: '<p>1</p>' });
  tools.retire_app({ id: 'lab', reason: 'Asked instead.', replacedBy: 'pick' });
  assert.equal(store.state.apps.lab.retired.replacedBy.title, 'My question');
});

test('#193: a topic thread’s fork is told the app is in the conversation, not that it doesn’t exist (#216)', () => {
  const { rt, se, other, tools, theirs } = setup();
  tools.show_app({ id: 'lab', title: 'Practice lab', code: '<p>1</p>' });
  rt.updateSession(other.id, { forkOf: { sessionId: se.id, itemId: null } });
  for (const r of [theirs.retire_app({ id: 'lab', reason: 'Gone.' }), theirs.update_app({ id: 'lab', code: '<p>2</p>' })]) {
    assert.equal(r.ok, false);
    assert.match(r.message, /App lab is in the conversation, not in this thread, and it can’t be changed from here/);
  }
});

test('#193: retire_app is one of the MCP tools, with a reason it requires', () => {
  const def = TOOL_DEFS.find((d) => d.name === 'retire_app');
  assert.ok(def);
  assert.deepEqual(def.inputSchema.required, ['id', 'reason']);
  assert.match(def.description, /rather than updating it to a version that only points elsewhere/);
});
