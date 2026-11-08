// #990: a persona’s folder stored before it was checked, a relative one say, is refused everywhere Postbox reads it
// to work in: the turn (server/adapters/folder.mjs), `!` commands, the permissions panel, the files an agent names
// and the work ledger, for an agent whose adapter has its own folderFor and for one whose adapter has none (the mock).
// The refusal is a 409, so a route answers with its message: the request is fine, the agent’s stored folder isn’t,
// and the person changes it in the sheet. The persona sheet’s MCP servers and skills read nothing relative to it.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const RELATIVE = 'Write the folder’s full path, starting with /. Postbox doesn’t guess where a relative one is.';
/** The refusal of a stored folder, as the person reads it. */
const refused = (handle, shown, why) =>
  `Postbox couldn’t open the folder ${shown} for @${handle}: ${why} Change it in @${handle}’s sheet, under Folder, or leave it empty to work in the project’s root folder.`;

/** An adapter with no folderFor of its own, as the mock has none. */
const noFolderFor = { name: 'mock', deliver: async (_se, _m, ctx) => ctx.text('ok') };

function setup() {
  const data = tempDir('pb-persona-folder-stored-');
  const store = new Store(null);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const adapters = new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot: join(data, 'workspaces') })).register(noFolderFor);
  const rt = new Runtime({ store, adapters, corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/srv/project' });
  /** An agent on this backend, in a conversation of its own, whose folder was stored as `server` before #990. */
  const stored = (handle, backend) => {
    const p = rt.createPersona({ handle, backend, folder: '/srv/ok' });
    store.emit('persona', { ...store.state.personas[p.id], folder: 'server' });
    const t = rt.createThread({ projectId: 'p1', title: handle, personaIds: [p.id] });
    return { p, t, se: rt.sessionsIn(t.id)[0] };
  };
  return { store, rt, stored };
}

/** A 409 with exactly the refusal of @handle’s stored `server`. */
const refusal = (handle) => (e) => {
  assert.equal(e.status, 409, e.message);
  assert.equal(e.message, refused(handle, '"server"', RELATIVE));
  return true;
};

test('`!` in a conversation whose agent has a stored relative folder is refused with a 409, and runs nothing', async () => {
  const { store, rt, stored } = setup();
  for (const [handle, backend] of [
    ['cc', 'claude-code'],
    ['mo', 'mock'],
  ]) {
    const { t } = stored(handle, backend);
    await assert.rejects(() => rt.commandFolder(t.id), refusal(handle));
    await assert.rejects(() => rt.runShellCommand(t.id, 'ls'), refusal(handle));
    assert.deepEqual(
      store.items(t.id).filter((i) => i.kind === 'command'),
      [],
    );
  }
});

test('the permissions panel for an agent with a stored relative folder is refused with a 409', async () => {
  const { rt, stored } = setup();
  for (const [handle, backend] of [
    ['cc', 'claude-code'],
    ['mo', 'mock'],
  ]) {
    const { p, se } = stored(handle, backend);
    await assert.rejects(() => rt.panelTarget({ personaId: p.id }), refusal(handle));
    await assert.rejects(() => rt.panelTarget({ sessionId: se.id }), refusal(handle));
  }
});

test('the folders an agent with a stored relative folder names files from are refused with a 409', async () => {
  const { rt, stored } = setup();
  for (const [handle, backend] of [
    ['cc', 'claude-code'],
    ['mo', 'mock'],
  ])
    await assert.rejects(() => rt.agentFolders(stored(handle, backend).se.id), refusal(handle));
});

test('the work ledger of a turn by an agent with no folderFor and a stored relative folder never gets that folder', async () => {
  const { rt, stored } = setup();
  const { t } = stored('mo', 'mock');
  const started = [];
  const startTurn = rt.ledger.startTurn.bind(rt.ledger);
  rt.ledger.startTurn = (turn, opts) => {
    started.push(opts.folder);
    return startTurn(turn, opts);
  };
  rt.sendMessage(t.id, { text: 'hi' });
  assert.equal(started.length, 1);
  await assert.rejects(() => Promise.resolve(started[0]), refusal('mo'));
});

test('the persona sheet’s MCP servers and skills treat a stored relative folder as no folder', () => {
  const { store, rt, stored } = setup();
  const { p, se } = stored('cc', 'claude-code');
  // Its own init, from the project’s folder: its project servers count there.
  store.emit('session', { ...store.state.sessions[se.id], mcpServers: { at: 1, servers: [{ name: 'proj', source: 'project' }] } });
  const ctx = rt.mcpContext(p.id, 'p1');
  assert.equal(ctx.folder, '/srv/project');
  assert.deepEqual(
    ctx.seen.map((s) => s.name),
    ['proj'],
  );
  assert.equal(rt.mcpContext(p.id, null).folder, '/srv/project', 'its latest conversation’s project');
  const lone = rt.createPersona({ handle: 'lone', backend: 'mock' });
  store.emit('persona', { ...store.state.personas[lone.id], folder: '../x' });
  assert.equal(rt.mcpContext(lone.id, null).folder, null);
});
