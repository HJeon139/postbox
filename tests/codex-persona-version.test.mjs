// One rule for settings: a persona edit reaches a Codex session
// that’s already going from its next turn, its instructions as much as its permissions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { CODEX_ROOT, fakeAppServer } from './codex-fixture.mjs';

async function deliver(rt, threadId, sessionId) {
  rt.sendMessage(threadId, { text: 'Report the result.' });
  const turn = rt.turns.get(sessionId);
  assert.ok(turn, 'the runtime started the actual adapter path');
  await turn.exited;
  await new Promise(setImmediate);
  assert.equal(rt.turns.has(sessionId), false);
}

test('editing a persona between Codex turns reaches the existing session from its next turn', async () => {
  const seen = [];
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen) });
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'project', name: 'Test', folder: CODEX_ROOT });
  const persona = rt.createPersona({ handle: 'coder', backend: 'codex', instructions: 'Original pinned instruction.' });
  const thread = rt.createThread({ projectId: 'project', title: 'Pinned', personaIds: [persona.id] });
  const session = rt.sessionsIn(thread.id)[0];
  await deliver(rt, thread.id, session.id);
  rt.updatePersona(persona.id, { instructions: 'Edited instruction for new sessions.', permissionMode: 'bypass' });
  await deliver(rt, thread.id, session.id);
  const first = seen.find((request) => request.method === 'thread/start');
  const resumed = seen.find((request) => request.method === 'thread/resume');
  assert.match(first.params.developerInstructions, /Original pinned instruction\./);
  assert.match(resumed.params.developerInstructions, /Edited instruction for new sessions\./);
  assert.doesNotMatch(resumed.params.developerInstructions, /Original pinned instruction\./);
  assert.equal(seen.filter((request) => request.method === 'turn/start')[1].params.sandboxPolicy.type, 'dangerFullAccess');
  const fresh = rt.createThread({ projectId: 'project', title: 'New version', personaIds: [persona.id] });
  await deliver(rt, fresh.id, rt.sessionsIn(fresh.id)[0].id);
  const starts = seen.filter((request) => request.method === 'thread/start');
  assert.match(starts[1].params.developerInstructions, /Edited instruction for new sessions\./);
});
