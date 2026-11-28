// #990 and #120: an agent placed on a host works there in the project’s folder on that host, or one of its own there
// (server/remote/turns-start.mjs), never in its sheet’s Folder, so a folder on this computer isn’t checked for it.
// Its sheet re-sends Folder with every save, so one stored before #990, a relative one say, would otherwise refuse
// every change to the agent until Folder was cleared. What reads its folder here (the permissions panel, the files it
// names) reads none of its own, whatever it names. Moved back to this computer, its folder is checked again.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { MockAdapter } from '../server/adapters/mock.mjs';
import { NO_SERVER_FOLDER, storedFolder } from '../server/folder-path.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { FakeHosts } from './remote-runtime-helpers.mjs';
import { tempDir } from './temp-dirs.mjs';

const RELATIVE = 'Write the folder’s full path, starting with /. Postbox doesn’t guess where a relative one is.';
const NOT_TEXT = 'An agent’s folder is its full path, as text. Write the folder’s full path.';
const TOO_LONG = 'A folder’s path is at most 4096 characters. Pick a folder with a shorter path.';

function setup({ hosted = false } = {}) {
  const data = tempDir('pb-persona-folder-host-');
  const store = new Store(null);
  const adapters = new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot: join(data, 'workspaces') })).register(new MockAdapter());
  const config = { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, hosted };
  const rt = new Runtime({ store, adapters, config, hosts: new FakeHosts() });
  const project = join(data, 'project');
  store.emit('project', { id: 'p1', name: 'P', folder: project });
  const host = rt.addHost({ name: 'host.example.com' });
  return { store, rt, host, project, data };
}

/** A 422 with exactly this message. */
const refusal = (message) => (e) => {
  assert.equal(e.status, 422, e.message);
  assert.equal(e.message, message);
  return true;
};

test('making an agent on a host keeps the folder as written, unchecked, and refuses one that isn’t text', () => {
  const { store, rt, host } = setup();
  const remote = { hostId: host.id };
  assert.equal(rt.createPersona({ handle: 'alpha', backend: 'claude-code', remote, folder: 'server' }).folder, 'server');
  assert.equal(rt.createPersona({ handle: 'beta', backend: 'claude-code', remote, folder: '/srv/b/' }).folder, '/srv/b/');
  assert.equal(rt.createPersona({ handle: 'gamma', backend: 'claude-code', remote, folder: '' }).folder, '');
  assert.equal(rt.createPersona({ handle: 'delta', backend: 'claude-code', remote, folder: null }).folder, '');
  assert.equal(rt.createPersona({ handle: 'eps', backend: 'claude-code', remote }).folder, '');
  // 4096 characters, the most taken, and relative, so only the length is checked.
  const longest = 'a'.repeat(4096);
  assert.equal(rt.createPersona({ handle: 'zeta', backend: 'claude-code', remote, folder: longest }).folder, longest);
  const made = Object.keys(store.state.personas).length;
  assert.throws(() => rt.createPersona({ handle: 'eta', backend: 'claude-code', remote, folder: 42 }), refusal(NOT_TEXT));
  assert.throws(() => rt.createPersona({ handle: 'eta', backend: 'claude-code', remote, folder: ['/srv'] }), refusal(NOT_TEXT));
  assert.throws(() => rt.createPersona({ handle: 'eta', backend: 'claude-code', remote, folder: `/${'a'.repeat(4096)}` }), refusal(TOO_LONG));
  assert.equal(Object.keys(store.state.personas).length, made);
  // On this computer it’s checked.
  assert.throws(() => rt.createPersona({ handle: 'theta', backend: 'claude-code', folder: 'server' }), refusal(RELATIVE));
});

test('an agent on a host with a folder stored before #990 saves its sheet’s other fields, Folder re-sent as it is', () => {
  const { store, rt, host } = setup();
  const p = rt.createPersona({ handle: 'alpha', backend: 'claude-code', remote: { hostId: host.id } });
  store.emit('persona', { ...store.state.personas[p.id], folder: 'server' });
  const next = rt.updatePersona(p.id, { description: 'changed', folder: 'server' });
  assert.equal(next.description, 'changed');
  assert.equal(next.folder, 'server');
  assert.equal(rt.updatePersona(p.id, { folder: '~/work' }).folder, '~/work');
  assert.throws(() => rt.updatePersona(p.id, { folder: 42, description: 'not saved' }), refusal(NOT_TEXT));
  assert.equal(store.state.personas[p.id].description, 'changed');
});

test('moving an agent to a host takes its folder unchecked, and moving it back to this computer checks it', () => {
  const { store, rt, host } = setup();
  const p = rt.createPersona({ handle: 'alpha', backend: 'claude-code', folder: '/srv/a' });
  assert.equal(rt.updatePersona(p.id, { remote: { hostId: host.id }, folder: 'server' }).folder, 'server');
  assert.throws(() => rt.updatePersona(p.id, { remote: null, folder: 'server' }), refusal(RELATIVE));
  assert.deepEqual(store.state.personas[p.id].remote, { hostId: host.id }, 'a refused move leaves it where it was');
  assert.throws(() => rt.updatePersona(p.id, { remote: null, folder: '~/x' }), refusal(RELATIVE));
  const back = rt.updatePersona(p.id, { remote: null, folder: '/srv/a' });
  assert.equal(back.remote, null);
  assert.equal(back.folder, '/srv/a');
});

test('the permissions panel and the files of an agent on a host read a folder the check refuses as none of its own', async () => {
  const { store, rt, host, project } = setup();
  const p = rt.createPersona({ handle: 'alpha', backend: 'claude-code', remote: { hostId: host.id } });
  store.emit('persona', { ...store.state.personas[p.id], folder: 'server' });
  const t = rt.createThread({ projectId: 'p1', title: 'alpha', personaIds: [p.id] });
  const se = arrange.sessionsIn(rt, t.id)[0];
  assert.equal((await rt.panelTarget({ sessionId: se.id })).folder, project);
  assert.equal((await rt.panelTarget({ personaId: p.id, projectId: 'p1' })).folder, project);
  assert.deepEqual(await arrange.agentFolders(rt, se.id), [project]);
  // The same folder on an agent here is still refused, with where to change it.
  const here = rt.createPersona({ handle: 'beta', backend: 'claude-code' });
  store.emit('persona', { ...store.state.personas[here.id], folder: 'server' });
  await assert.rejects(
    () => rt.panelTarget({ personaId: here.id, projectId: 'p1' }),
    (e) => e.status === 409,
  );
});

test('an agent on a host has no folder of its own here, whatever its folder names: nothing here is made at that path or read from it', async () => {
  const { rt, host, data } = setup();
  const named = join(data, 'named-on-the-host');
  const p = rt.createPersona({ handle: 'alpha', backend: 'claude-code', remote: { hostId: host.id }, folder: named });
  assert.equal(p.folder, named, 'kept for its host, as written');
  assert.equal(storedFolder(p), '');
  assert.equal(storedFolder({ ...p, folder: 'relative' }), '');
  // What reads an agent’s folder on this computer, the permissions panel, makes the folder it reads.
  const view = await rt.permissionsView({ personaId: p.id });
  assert.equal(existsSync(named), false, 'the named path isn’t made here');
  assert.notEqual(view.folder, named);
  // On this computer the same folder is the agent’s own, as before.
  assert.equal(storedFolder({ handle: 'beta', folder: named, remote: null }), named);
});

test('hosted, an agent moved from its host to the server is refused while it has a folder, and keeps it', () => {
  const { store, rt, host } = setup({ hosted: true });
  const p = rt.createPersona({ handle: 'alpha', backend: 'claude-code', remote: { hostId: host.id }, folder: '/srv/work' });
  assert.throws(
    () => rt.updatePersona(p.id, { remote: null, backend: 'mock' }),
    (/** @type {any} */ e) => e.status === 422 && e.message === NO_SERVER_FOLDER,
  );
  assert.deepEqual([store.state.personas[p.id].folder, store.state.personas[p.id].remote], ['/srv/work', { hostId: host.id }]);
  // With its folder cleared in the same change, or none to begin with, it moves.
  assert.equal(rt.updatePersona(p.id, { remote: null, backend: 'mock', folder: '' }).folder, '');
  const q = rt.createPersona({ handle: 'beta', backend: 'claude-code', remote: { hostId: host.id } });
  assert.equal(rt.updatePersona(q.id, { remote: null, backend: 'mock' }).remote, null);
});

test('on your own computer a move from a host checks only a folder the change names, as before', () => {
  const { rt, host } = setup();
  const p = rt.createPersona({ handle: 'alpha', backend: 'claude-code', remote: { hostId: host.id }, folder: 'relative' });
  assert.equal(rt.updatePersona(p.id, { remote: null, backend: 'mock' }).folder, 'relative');
});

test('hosted, a folder an agent placed on the server was given before is ignored: cleared as Postbox starts, and an agent on a host keeps its own', () => {
  const store = new Store(null);
  store.emit('host', { id: 'ho_1', name: 'host.example.com', settings: {}, createdAt: 1 });
  store.emit('persona', { id: 'pe_a', handle: 'here-before', backend: 'mock', folder: '/srv/saved-before', remote: null, version: 3 });
  store.emit('persona', { id: 'pe_b', handle: 'on-a-host', backend: 'claude-code', folder: '/srv/on-its-host', remote: { hostId: 'ho_1' }, version: 2 });
  store.emit('persona', { id: 'pe_c', handle: 'no-folder', backend: 'mock', folder: '', remote: null, version: 1 });
  const start = (/** @type {boolean} */ hosted) =>
    new Runtime({
      store,
      adapters: new AdapterRegistry().register(new MockAdapter()),
      config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, hosted },
      hosts: new FakeHosts(),
    });
  // On your own computer nothing is cleared.
  start(false);
  assert.equal(store.state.personas.pe_a.folder, '/srv/saved-before');
  // From here a hosted start writes only the folder it clears: one agent’s once, then nothing.
  const written = () => store.state.seq;
  const before = written();
  start(true);
  assert.equal(written(), before + 1, 'one write, for the one agent with a folder to clear');
  start(true);
  assert.equal(written(), before + 1, 'a later hosted start writes nothing');
  const { pe_a, pe_b, pe_c } = store.state.personas;
  assert.deepEqual([pe_a.folder, pe_a.version, pe_a.handle], ['', 3, 'here-before'], 'cleared, and nothing else of the agent changed');
  assert.equal(pe_b.folder, '/srv/on-its-host');
  assert.equal(pe_c.folder, '');
});

/** A store with a project and a conversation whose two agents are one on a host and one on the server. */
function savedBefore() {
  const store = new Store(null);
  store.emit('host', { id: 'ho_1', name: 'host.example.com', settings: {}, createdAt: 1 });
  store.emit('project', { id: 'pr_a', name: 'Saved with a folder', folder: '/srv/project', pushUrl: 'https://github.com/owner/name.git' });
  store.emit('project', { id: 'pr_b', name: 'Named only' });
  store.emit('persona', { id: 'pe_here', handle: 'here', backend: 'mock', folder: '', remote: null, version: 1 });
  store.emit('persona', { id: 'pe_away', handle: 'away', backend: 'claude-code', folder: '', remote: { hostId: 'ho_1' }, version: 1 });
  store.emit('thread', { id: 'th_a', title: 'Room', projectId: 'pr_a' });
  store.emit('session', { id: 'se_here', threadId: 'th_a', personaId: 'pe_here', handle: 'here', addDirs: ['/srv/added', '/etc'], readDirs: [] });
  store.emit('session', { id: 'se_away', threadId: 'th_a', personaId: 'pe_away', handle: 'away', addDirs: [] });
  const start = (/** @type {boolean} */ hosted) =>
    new Runtime({
      store,
      adapters: new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot: join(tempDir('pb-saved-'), 'w') })).register(new MockAdapter()),
      config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, hosted },
      hosts: new FakeHosts(),
    });
  return { store, start };
}

test('hosted, a conversation’s or project’s folder saved before is ignored too: each is cleared once, as Postbox starts', () => {
  const { store, start } = savedBefore();
  start(false);
  assert.deepEqual(
    [store.state.projects.pr_a.folder, store.state.sessions.se_here.addDirs],
    ['/srv/project', ['/srv/added', '/etc']],
    'kept on your own computer',
  );
  const before = store.state.seq;
  start(true);
  assert.equal(store.state.seq, before + 2, 'two writes: the one project and the one conversation that had any');
  assert.deepEqual(store.state.projects.pr_a, { id: 'pr_a', name: 'Saved with a folder', pushUrl: 'https://github.com/owner/name.git' });
  assert.deepEqual(store.state.projects.pr_b, { id: 'pr_b', name: 'Named only' });
  assert.deepEqual([store.state.sessions.se_here.addDirs, store.state.sessions.se_here.threadId], [[], 'th_a']);
  start(true);
  assert.equal(store.state.seq, before + 2, 'a later hosted start writes nothing');
});
