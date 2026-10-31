// Existing sessions retain their persona instructions; live permissions can change.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { fakeAppServer } from './codex-fixture.mjs';

async function deliver(rt, threadId, sessionId) {
  rt.sendMessage(threadId, { text: 'Report the result.' });
  const turn = rt.turns.get(sessionId);
  assert.ok(turn, 'the runtime started the actual adapter path');
  await turn.exited;
  await new Promise(setImmediate);
  assert.equal(rt.turns.has(sessionId), false);
}

test('editing a persona between Codex turns preserves the existing session’s pinned instructions', async () => {
  const seen = [];
  const adapter = new CodexAdapter({ spawnImpl: () => fakeAppServer(seen) });
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'project', name: 'Test', folder: '/tmp' });
  const persona = rt.createPersona({ handle: 'coder', backend: 'codex', instructions: 'Original pinned instruction.' });
  const thread = rt.createThread({ projectId: 'project', title: 'Pinned', personaIds: [persona.id] });
  const session = rt.sessionsIn(thread.id)[0];
  await deliver(rt, thread.id, session.id);
  rt.updatePersona(persona.id, { instructions: 'Edited instruction for new sessions.', permissionMode: 'ask' });
  await deliver(rt, thread.id, session.id);
  const first = seen.find((request) => request.method === 'thread/start');
  const resumed = seen.find((request) => request.method === 'thread/resume');
  assert.equal(resumed.params.developerInstructions, first.params.developerInstructions);
  assert.match(resumed.params.developerInstructions, /Original pinned instruction\./);
  assert.doesNotMatch(resumed.params.developerInstructions, /Edited instruction for new sessions\./);
  assert.equal(seen.filter((request) => request.method === 'turn/start')[1].params.sandboxPolicy.type, 'readOnly');
  const fresh = rt.createThread({ projectId: 'project', title: 'New version', personaIds: [persona.id] });
  await deliver(rt, fresh.id, rt.sessionsIn(fresh.id)[0].id);
  const starts = seen.filter((request) => request.method === 'thread/start');
  assert.match(starts[1].params.developerInstructions, /Edited instruction for new sessions\./);
});
