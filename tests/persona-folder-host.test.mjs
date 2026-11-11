// #990 and #120: an agent placed on a host works there in the project’s folder on that host, or one of its own there
// (server/remote/turns-start.mjs), never in its sheet’s Folder, so a folder on this computer isn’t checked for it.
// Its sheet re-sends Folder with every save, so one stored before #990, a relative one say, would otherwise refuse
// every change to the agent until Folder was cleared. What reads its folder here (the permissions panel, the files it
// names) reads one the check refuses as no folder of its own. Moved back to this computer, its folder is checked again.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { FakeHosts } from './remote-runtime-helpers.mjs';
import { tempDir } from './temp-dirs.mjs';

const RELATIVE = 'Write the folder’s full path, starting with /. Postbox doesn’t guess where a relative one is.';
const NOT_TEXT = 'An agent’s folder is its full path, as text. Write the folder’s full path.';
const TOO_LONG = 'A folder’s path is at most 4096 characters. Pick a folder with a shorter path.';

function setup() {
  const data = tempDir('pb-persona-folder-host-');
  const store = new Store(null);
  const adapters = new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot: join(data, 'workspaces') }));
  const config = { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 };
  const rt = new Runtime({ store, adapters, config, hosts: new FakeHosts() });
  const project = join(data, 'project');
  store.emit('project', { id: 'p1', name: 'P', folder: project });
  const host = rt.addHost({ name: 'host.example.com' });
  return { store, rt, host, project };
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
  const se = rt.sessionsIn(t.id)[0];
  assert.equal((await rt.panelTarget({ sessionId: se.id })).folder, project);
  assert.equal((await rt.panelTarget({ personaId: p.id, projectId: 'p1' })).folder, project);
  assert.deepEqual(await rt.agentFolders(se.id), [project]);
  // The same folder on an agent here is still refused, with where to change it.
  const here = rt.createPersona({ handle: 'beta', backend: 'claude-code' });
  store.emit('persona', { ...store.state.personas[here.id], folder: 'server' });
  await assert.rejects(
    () => rt.panelTarget({ personaId: here.id, projectId: 'p1' }),
    (e) => e.status === 409,
  );
});
