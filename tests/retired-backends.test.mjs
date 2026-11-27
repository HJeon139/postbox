// The Agent SDK backend is gone (server/retired-backends.mjs, #1831): what a store an older Postbox wrote holds on it
// runs on Claude Code once Postbox loads, with nothing for the person to answer.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { ScriptedAdapter, settle, setup } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const CONFIG = { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 };
/** A Postbox whose only backends are scripted ones under these names. @param {Store} store @param {string[]} names */
function loaded(store, names) {
  const adapters = new AdapterRegistry();
  const byName = Object.fromEntries(names.map((name) => [name, Object.assign(new ScriptedAdapter(), { name })]));
  for (const adapter of Object.values(byName)) adapters.register(adapter);
  return { rt: new Runtime({ store, adapters, config: CONFIG }), byName };
}

test('a persona, its session, a saved agent and a quota record stored on the Agent SDK are on Claude Code once Postbox loads, written once', () => {
  const { store, a, b, alpha, beta } = setup();
  store.emit('persona', { ...store.state.personas[a.id], backend: 'agent-sdk', model: 'claude-sonnet-5-5' });
  store.emit('session.patch', { id: alpha.id, patch: { backend: 'agent-sdk', backendState: { sdkSessionId: 'sdk-1', contextWindow: 200000 } } });
  store.emit('session.patch', { id: beta.id, patch: { backendState: { claudeSessionId: 'cc-2', sdkSessionId: 'sdk-old' } } });
  store.emit('boilerplate', { id: 'bp_1', name: '@alpha', description: '', instructions: '', tools: [], backend: 'agent-sdk', model: 'claude-sonnet-5-5' });
  store.emit('quota', { id: 'agent-sdk', backend: 'agent-sdk', host: null, status: 'ok', windows: [], seenAt: 1 });
  store.emit('quota', { id: 'claude-code', backend: 'claude-code', host: null, status: 'ok', windows: [], seenAt: 1 });

  const { rt } = loaded(store, ['mock', 'claude-code']);
  const s = store.state;
  assert.deepEqual([s.personas[a.id].backend, s.personas[a.id].model], ['claude-code', 'claude-sonnet-5-5'], 'the same model, on Claude Code');
  assert.equal(s.personas[b.id].backend, 'mock', 'an agent on another backend stays on it');
  assert.equal(s.sessions[alpha.id].backend, 'claude-code');
  assert.deepEqual(s.sessions[alpha.id].backendState, { claudeSessionId: 'sdk-1', contextWindow: 200000 }, 'its next turn resumes the session it was in');
  assert.deepEqual(s.sessions[beta.id].backendState, { claudeSessionId: 'cc-2' }, 'an agent since moved to Claude Code keeps Claude Code’s session');
  assert.equal(s.boilerplates.bp_1.backend, 'claude-code');
  assert.deepEqual(Object.keys(s.quota), ['claude-code'], 'the SDK’s own quota record goes: Claude Code reports the same account’s');
  assert.equal(s.sessions[alpha.id].needs ?? null, null, 'nothing waits on the person');
  assert.equal(JSON.stringify(s).includes('agent-sdk'), false, 'nothing stored names the backend');
  assert.equal(rt.persona(a.id).backend, 'claude-code');

  const seq = s.seq;
  loaded(store, ['mock', 'claude-code']);
  assert.equal(store.state.seq, seq, 'a store with nothing on the Agent SDK writes nothing');
});

test('a fork point the SDK recorded names its session as Claude Code’s, so a topic thread still starts at its message', () => {
  const { store, a, alpha } = setup();
  store.emit('persona', { ...store.state.personas[a.id], backend: 'agent-sdk' });
  store.emit('session.patch', { id: alpha.id, patch: { backendState: { fork: { sdkSessionId: 'sdk-1', uuid: 'u-9' }, forkFrom: { sdkSessionId: 'sdk-1' } } } });
  loaded(store, ['mock', 'claude-code']);
  assert.deepEqual(store.state.sessions[alpha.id].backendState, { fork: { claudeSessionId: 'sdk-1', uuid: 'u-9' }, forkFrom: { claudeSessionId: 'sdk-1' } });
});

test('an event log that names the Agent SDK replays, and its agent’s next turn runs on Claude Code in the session it had', async () => {
  const dir = tempDir('pb-retired-');
  const old = await new Store(dir).load();
  const before = setup(old);
  old.emit('persona', { ...old.state.personas[before.a.id], backend: 'agent-sdk' });
  old.emit('session.patch', { id: before.alpha.id, patch: { backend: 'agent-sdk', backendState: { sdkSessionId: 'sdk-1' } } });
  await old.close();

  const store = await new Store(dir).load();
  assert.equal(store.state.personas[before.a.id].backend, 'agent-sdk', 'the log replays as it was written');
  const { rt, byName } = loaded(store, ['mock', 'claude-code']);
  byName['claude-code'].rt = rt;
  rt.sendMessage(before.t.id, { text: '@alpha go' });
  await settle(rt);
  const [turn] = byName['claude-code'].calls;
  assert.equal(turn?.handle, 'alpha', 'its turn ran on Claude Code');
  assert.equal(turn.state.claudeSessionId, 'sdk-1', 'with the session it had to resume');
  assert.equal(arrange.sessionsIn(rt, before.t.id).find((se) => se.handle === 'alpha')?.needs ?? null, null, 'and nothing waits on the person');
  await store.close();
});
