// #1811, #1812: /compact for a Kiro CLI or an Antigravity agent reached the model as a prompt, and nothing was
// compacted. Neither harness offers a compaction Postbox can run in a headless turn: Kiro’s docs list /compact only for
// its interactive chat, and `kiro-cli chat --help` (3.6.2) has no compaction option; Antigravity’s docs and `agy --help`
// (1.5.18) name none, and Postbox runs agy with --disable-slash-commands. So each refuses it before anything is posted
// or started, through the hook #1807 added for Codex (server/agent-commands.mjs), saying why.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { tempDir } from './temp-dirs.mjs';

/** No turn may start here: a spawn fails the test rather than run a real CLI. */
const spawnImpl = () => {
  throw new Error('This test starts no process.');
};
const BIN = '/nonexistent/postbox-test-cli';

const CASES = [
  {
    backend: 'kiro-cli',
    handle: 'kiro',
    make: (root) => new KiroCliAdapter({ bin: BIN, workRoot: root, isolatedHome: tempDir('pb-kiro-home-'), spawnImpl }),
    reason: '@kiro can’t compact its conversation: Kiro CLI has no compaction Postbox can run.',
  },
  {
    backend: 'antigravity-cli',
    handle: 'agy',
    make: (root) => new AntigravityCliAdapter({ bin: BIN, workRoot: root, spawnImpl }),
    reason: '@agy can’t compact its conversation: Antigravity has no compaction Postbox can run.',
  },
];

for (const { backend, handle, make, reason } of CASES)
  test(`#1811 #1812 /compact for a ${backend} agent is refused with its reason, before anything is posted or started`, () => {
    const root = tempDir('pb-compact-');
    const store = new Store(null);
    const adapter = make(root);
    const rt = new Runtime({
      store,
      adapters: new AdapterRegistry().register(adapter),
      config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    });
    store.emit('project', { id: 'p1', name: 'P', folder: root });
    const p = rt.createPersona({ handle, backend });
    const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
    const se = arrange.sessionsIn(rt, t.id)[0];
    const before = store.items(t.id).length;
    assert.throws(
      () => rt.runAgentCommand(t.id, { sessionId: se.id, text: '/compact' }),
      (e) => e.status === 422 && e.message === reason,
    );
    assert.equal(store.items(t.id).length, before, 'nothing posted');
    assert.equal(rt.turns.size, 0, 'no turn');
    // With words after it too; a longer name isn’t this command, and another command goes on.
    assert.equal(adapter.refuses('/compact now', {}, handle), reason);
    assert.equal(adapter.refuses('/compactor', {}, handle), null);
    assert.equal(adapter.refuses('/review', {}, handle), null);
  });
