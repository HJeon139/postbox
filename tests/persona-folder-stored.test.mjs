// #990: a persona’s folder stored before it was checked, a relative one say, is refused everywhere Postbox reads it
// to work in: the turn (server/adapters/folder.mjs), `!` commands, the permissions panel, the files an agent names
// and the work ledger, for an agent whose adapter has its own folderFor and for one whose adapter has none (the mock).
// The refusal is a 409, so a route answers with its message: the request is fine, the agent’s stored folder isn’t,
// and the person changes it in the sheet. The persona sheet’s MCP servers and skills read nothing relative to it.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { workFolder } from '../server/adapters/folder.mjs';
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

/**
 * An agent with a valid folder, in a conversation started while its folder was stored as `server` before #990: its
 * session’s snapshot holds `server`, as old data does. Then its folder is changed in its sheet to `folder`.
 */
function snapshotted(rt, store, handle, backend, folder) {
  const p = rt.createPersona({ handle, backend, folder: '/srv/ok' });
  const t = rt.createThread({ projectId: 'p1', title: handle, personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  store.emit('session', { ...store.state.sessions[se.id], personaSnapshot: { ...se.personaSnapshot, folder: 'server' } });
  store.emit('persona', { ...store.state.personas[p.id], folder });
  return { p, t, se: store.state.sessions[se.id] };
}

/**
 * A turn by the mock agent in `t`: the folder the work ledger is given as it starts, and the persona the adapter is
 * handed, whose folder a real backend starts in (its folderFor).
 */
function turn(rt, t) {
  const started = [];
  const startTurn = rt.ledger.startTurn.bind(rt.ledger);
  rt.ledger.startTurn = (turn, opts) => {
    started.push(opts.folder);
    return startTurn(turn, opts);
  };
  const { promise: delivered, resolve } = Promise.withResolvers();
  noFolderFor.deliver = async (_se, _m, ctx) => {
    resolve(ctx.persona);
    ctx.text('ok');
  };
  rt.sendMessage(t.id, { text: 'hi' });
  rt.ledger.startTurn = startTurn;
  assert.equal(started.length, 1);
  return { ledger: Promise.resolve(started[0]), delivered };
}

test('a conversation whose snapshot holds a bad folder works in the agent’s folder once its sheet is fixed', async () => {
  const { store, rt } = setup();
  const cwdBefore = readdirSync(process.cwd());
  for (const [handle, backend] of [
    ['cc', 'claude-code'],
    ['mo', 'mock'],
  ]) {
    const fixed = tempDir(`pb-persona-folder-fixed-${handle}-`);
    const { t, se } = snapshotted(rt, store, handle, backend, fixed);
    assert.equal(se.personaSnapshot.folder, 'server', 'the snapshot still holds the bad folder');
    assert.equal(rt.personaFor(se).folder, fixed);
    assert.equal(await workFolder(rt.adapters.get(backend), rt.personaFor(se), store.state.projects.p1), fixed);
    assert.deepEqual(await rt.commandFolder(t.id), { folder: fixed, host: null });
    assert.equal((await rt.panelTarget({ sessionId: se.id })).folder, fixed);
    assert.deepEqual(await rt.agentFolders(se.id), [fixed, '/srv/project']);
    if (backend === 'mock') {
      const { ledger, delivered } = turn(rt, t);
      assert.equal(await ledger, fixed);
      assert.equal((await delivered).folder, fixed);
    }
  }
  assert.deepEqual(readdirSync(process.cwd()), cwdBefore, 'nothing is made in the folder Postbox was started from');
});

test('a conversation whose snapshot and agent both hold a bad folder is refused with the agent’s folder', async () => {
  const { store, rt } = setup();
  const cwdBefore = readdirSync(process.cwd());
  for (const [handle, backend] of [
    ['cc', 'claude-code'],
    ['mo', 'mock'],
  ]) {
    const { t, se } = snapshotted(rt, store, handle, backend, '../x');
    const refusedLive = (e) => {
      assert.equal(e.status, 409, e.message);
      assert.equal(e.message, refused(handle, '"../x"', RELATIVE));
      return true;
    };
    await assert.rejects(() => rt.commandFolder(t.id), refusedLive);
    await assert.rejects(() => rt.panelTarget({ sessionId: se.id }), refusedLive);
    await assert.rejects(() => rt.agentFolders(se.id), refusedLive);
    if (backend === 'mock') await assert.rejects(() => turn(rt, t).ledger, refusedLive);
  }
  assert.deepEqual(readdirSync(process.cwd()), cwdBefore, 'nothing is made in the folder Postbox was started from');
});

test('a conversation already going works in the agent’s new folder from its next turn after the folder changes', async () => {
  const { store, rt } = setup();
  for (const [handle, backend] of [
    ['cc', 'claude-code'],
    ['mo', 'mock'],
  ]) {
    const started = tempDir(`pb-persona-folder-started-${handle}-`);
    const later = tempDir(`pb-persona-folder-later-${handle}-`);
    const p = rt.createPersona({ handle, backend, folder: started });
    const t = rt.createThread({ projectId: 'p1', title: handle, personaIds: [p.id] });
    const se = rt.sessionsIn(t.id)[0];
    rt.updatePersona(p.id, { folder: later });
    assert.equal(store.state.personas[p.id].folder, later);
    assert.equal(rt.personaFor(se).folder, later);
    assert.deepEqual(await rt.commandFolder(t.id), { folder: later, host: null });
    assert.equal((await rt.panelTarget({ sessionId: se.id })).folder, later);
    if (backend === 'mock') assert.equal((await turn(rt, t).delivered).folder, later);
  }
});

test('a conversation whose agent had no folder works in the one its sheet gets, from its next turn', async () => {
  const { store, rt } = setup();
  const later = tempDir('pb-persona-folder-later-');
  const p = rt.createPersona({ handle: 'mo', backend: 'mock' });
  const t = rt.createThread({ projectId: 'p1', title: 'mo', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.updatePersona(p.id, { folder: later });
  assert.equal(store.state.personas[p.id].folder, later);
  assert.equal(rt.personaFor(se).folder, later);
  assert.deepEqual(await rt.commandFolder(t.id), { folder: later, host: null });
  assert.equal((await rt.panelTarget({ sessionId: se.id })).folder, later);
  assert.equal((await turn(rt, t).delivered).folder, later);
});

test('a conversation from before snapshots works in its agent’s folder', async () => {
  const { store, rt } = setup();
  const folder = tempDir('pb-persona-folder-unsnapshotted-');
  const p = rt.createPersona({ handle: 'mo', backend: 'mock', folder });
  const t = rt.createThread({ projectId: 'p1', title: 'mo', personaIds: [p.id] });
  const { personaSnapshot: _none, ...old } = rt.sessionsIn(t.id)[0];
  store.emit('session', old);
  const se = store.state.sessions[old.id];
  assert.equal(se.personaSnapshot, undefined);
  assert.equal(rt.personaFor(se).folder, folder);
  assert.deepEqual(await rt.commandFolder(t.id), { folder, host: null });
  assert.equal((await turn(rt, t).delivered).folder, folder);
});
