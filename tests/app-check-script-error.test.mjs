// A script error in the pre-display check goes back to the agent once, like any blocking problem, before the version
// shows as crashed (#964).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { fixEnded } from '../server/apps.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const THREW = [{ code: 'script-error', message: 'TypeError: r is negative (line 12, column 3)' }];

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
  const delivered = [];
  rt.deliver = (sessionId, message) => delivered.push({ sessionId, message });
  return { rt, session, delivered, tools: rt.toolsFor(session.id) };
}

test('#964 a script error in the first check goes back to the agent, and a fixed version that throws again is crashed', () => {
  const { rt, session, delivered, tools } = setup();
  tools.show_app({ id: 'jam', title: 'Traffic jam', code: '<p>Jam</p>' });
  assert.deepEqual(rt.appCheck('jam', { version: 1, problems: THREW }), { status: 'fixing' });
  assert.equal(rt.s.apps.jam.check.status, 'fixing');
  assert.deepEqual(delivered, [{ sessionId: session.id, message: { kind: 'app-check', appId: 'jam', problems: THREW } }]);

  tools.update_app({ id: 'jam', code: '<p>Jam, fixed</p>' });
  assert.deepEqual(rt.appCheck('jam', { version: 2, problems: THREW }), { status: 'crashed' });
  assert.equal(rt.s.apps.jam.check.status, 'crashed');
  assert.equal(delivered.length, 1, 'told once, not again');
});

test('#964 with no agent to tell, a script error is crashed at once', () => {
  const { rt, delivered, tools } = setup();
  tools.show_app({ id: 'jam', title: 'Traffic jam', code: '<p>Jam</p>' });
  rt.store.emit('app', { ...rt.s.apps.jam, sessionId: 'nobody' });
  assert.deepEqual(rt.appCheck('jam', { version: 1, problems: THREW }), { status: 'crashed' });
  assert.equal(delivered.length, 0);
});

test('#964 an app-check turn that ends without a new version leaves a script error crashed, and other problems a note', () => {
  assert.equal(fixEnded({ check: { problems: THREW } }), 'crashed');
  assert.equal(fixEnded({ check: { problems: [{ code: 'contrast', message: 'Low contrast.' }] } }), 'note');
});
