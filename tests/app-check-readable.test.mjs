// What the pre-display check finds about whether a visual can be read holds the version back, and goes to the agent
// to fix, once (#997): text under 12 px at 1000 × 680, text in boxes, a sentence in a box, a cut-off label, and an idea below the
// fold. A version still failing after the fix is shown with a note.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
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
  const delivered = [];
  rt.deliver = (sessionId, message) => delivered.push({ sessionId, message });
  return { rt, session, delivered, tools: rt.toolsFor(session.id) };
}

for (const code of ['text-too-small', 'text-in-boxes', 'words-in-box', 'text-cut-off', 'first-view'])
  test(`#997 ${code} holds the version back and goes to the agent; a fix that still has it is shown with a note`, () => {
    const { rt, session, delivered, tools } = setup();
    const problems = [{ code, message: 'At 1280 px, “Read file” (svg#flow > rect) …' }];
    tools.show_app({ id: 'flow', title: 'Flow', code: '<svg id="flow"></svg>' });
    assert.deepEqual(rt.appCheck('flow', { version: 1, problems }), { status: 'fixing' });
    assert.deepEqual(delivered, [{ sessionId: session.id, message: { kind: 'app-check', appId: 'flow', problems } }]);
    tools.update_app({ id: 'flow', code: '<svg id="flow"><text>Read</text></svg>' });
    assert.deepEqual(rt.appCheck('flow', { version: 2, problems }), { status: 'note' });
    assert.equal(rt.s.apps.flow.check.notes, undefined, 'a failure, not a warning');
    assert.equal(delivered.length, 1, 'told once, not again');
  });

test('#997 text under 12 px at 375 px alone is a warning: the app is shown with notes, and nothing goes back to fix', () => {
  const { rt, delivered, tools } = setup();
  tools.show_app({ id: 'flow', title: 'Flow', code: '<svg id="flow"></svg>' });
  const problems = [{ code: 'text-too-small-375', message: 'At 375 px, 4 of 9 labels are under 12 px …' }];
  assert.deepEqual(rt.appCheck('flow', { version: 1, problems }), { status: 'note' });
  assert.equal(rt.s.apps.flow.check.notes, true);
  assert.equal(delivered.filter((d) => d.message.kind === 'app-check').length, 0);
});
