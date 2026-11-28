// What a hosted Postbox answers when a conversation would add a folder (designs/architecture/hosted.md, “What assumed
// one computer”; server/permissions-panel.mjs): the server has none, so it is refused, and the refusal says what is so
// for the conversation’s agent. One on a host is told where its folder is set; one placed on the server, to move it
// to a host. The first wording told every agent to move to a host, the ones already on one too.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { MockAdapter } from '../server/adapters/mock.mjs';
import { NO_ADDED_FOLDER, NO_SERVER_FOLDER } from '../server/folder-path.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { FakeHosts } from './remote-runtime-helpers.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A hosted Postbox with one conversation of two agents: one on a host, one placed on the server. */
function hosted() {
  const store = new Store(null);
  store.emit('host', { id: 'ho_1', name: 'host.example.com', settings: {}, createdAt: 1 });
  store.emit('persona', { id: 'pe_here', handle: 'here', backend: 'mock', folder: '', remote: null, version: 1 });
  store.emit('persona', { id: 'pe_away', handle: 'away', backend: 'claude-code', folder: '', remote: { hostId: 'ho_1' }, version: 1 });
  store.emit('thread', { id: 'th_a', title: 'Room' });
  store.emit('session', { id: 'se_here', threadId: 'th_a', personaId: 'pe_here', handle: 'here', addDirs: [] });
  store.emit('session', { id: 'se_away', threadId: 'th_a', personaId: 'pe_away', handle: 'away', addDirs: [] });
  const adapters = new AdapterRegistry()
    .register(new ClaudeCodeAdapter({ bin: 'claude', workRoot: join(tempDir('pb-added-'), 'w') }))
    .register(new MockAdapter());
  return new Runtime({ store, adapters, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, hosted: true }, hosts: new FakeHosts() });
}

test('hosted, a conversation’s refusal says what is so for its agent: on a host, where its folder is set; on the server, to move it', async () => {
  const rt = hosted();
  await assert.rejects(rt.changePermissionFolder({ sessionId: 'se_away', path: '/srv/x' }), { status: 422, message: NO_ADDED_FOLDER });
  await assert.rejects(rt.changePermissionFolder({ sessionId: 'se_here', path: '/srv/x' }), { status: 422, message: NO_SERVER_FOLDER });
  assert.equal(
    NO_ADDED_FOLDER,
    'This Postbox runs on a server, so a conversation adds no folder here. Its agent works on its host: set the project’s folder there in Settings › Hosts.',
  );
  assert.deepEqual([rt.s.sessions.se_away.addDirs, rt.s.sessions.se_here.addDirs], [[], []], 'nothing is added');
});
