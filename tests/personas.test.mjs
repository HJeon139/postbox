// Personas’ interface (designs/architecture/services.md, “Personas”): creating, changing, finding and removing
// personas. Its invariants: a handle is unique among personas not retired, ignoring case; a persona’s backend is
// registered and can run where it’s placed; a stored retired permission mode runs as Auto. It signals
// persona.updated after a write. Built on an in-memory store, the adapter registry, a Placement over a set of
// sessions mid-turn, and a bus that records; it never builds Runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Personas } from '../server/personas.mjs';
import { Placement } from '../server/remote/placement.mjs';
import { Store } from '../server/store.mjs';

/**
 * Personas over an empty store with one project, the mock backend registered here, and a bus that records each signal
 * with the persona as the store held it then. `forgets` collects what each backend was asked to forget.
 * @param {{ midTurn?: string[] }} [o]
 */
function rig({ midTurn = [] } = {}) {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: '/work/p1' });
  const forgets = [];
  const adapters = new AdapterRegistry().register({ name: 'mock', capabilities: { remote: true }, forget: async (p) => forgets.push(p.handle) });
  const busy = new Set(midTurn);
  const placement = new Placement({ store, midTurn: (id) => busy.has(id), adapters, hosts: null });
  const emitted = [];
  const bus = { on() {}, emit: (signal, data) => emitted.push([signal, data, store.state.personas[data.persona?.id]?.version]) };
  const personas = new Personas({ store, bus, placement, adapters });
  return { store, bus, emitted, personas, forgets };
}

/** Asserts that `fn` throws an HTTP error with that status. */
function refused(fn, status) {
  assert.throws(fn, (/** @type {any} */ e) => e.status === status);
}

// ── Creating and finding ─────────────────────────────────────────────────────────────

test('create writes a persona at version 1, its handle without the @, and the mock’s model for the mock', () => {
  const { store, personas } = rig();
  const p = personas.create({ handle: '@alpha', description: 'Writes.' });
  assert.equal(p.handle, 'alpha');
  assert.equal(p.version, 1);
  assert.equal(p.model, 'mock');
  assert.equal(p.retired, false);
  assert.deepEqual(store.state.personas[p.id], p);
});

test('a handle is unique among personas not retired, ignoring case', () => {
  const { personas } = rig();
  const p = personas.create({ handle: 'alpha' });
  refused(() => personas.create({ handle: 'ALPHA' }), 409);
  personas.update(p.id, { retired: true });
  assert.equal(personas.create({ handle: 'Alpha' }).handle, 'Alpha', 'a retired one’s name can be taken');
});

test('create refuses a backend that isn’t registered, and a name that isn’t one', () => {
  const { personas } = rig();
  refused(() => personas.create({ handle: 'beta', backend: 'codex' }), 422);
  refused(() => personas.create({ handle: '1 no' }), 422);
});

test('get, byHandle and handles find personas; byHandle and handles leave the retired out', () => {
  const { personas } = rig();
  const a = personas.create({ handle: 'alpha' });
  const b = personas.create({ handle: 'beta' });
  personas.update(b.id, { retired: true });
  assert.equal(personas.get(a.id).handle, 'alpha');
  assert.equal(personas.get('pe_nowhere'), undefined);
  assert.equal(personas.byHandle('ALPHA').id, a.id);
  assert.equal(personas.byHandle('beta'), undefined);
  assert.deepEqual(personas.handles(), ['alpha']);
});

test('forSession gives the persona as a turn takes it: a stored retired mode runs Auto, and settings get defaults', () => {
  const { store, personas } = rig();
  const a = personas.create({ handle: 'alpha' });
  store.emit('persona', { ...store.state.personas[a.id], permissionMode: 'ask', usesHostSetup: undefined, mcpOff: undefined, tools: undefined });
  const p = personas.forSession({ personaId: a.id });
  assert.equal(p.permissionMode, 'auto');
  assert.equal(p.usesHostSetup, true);
  assert.equal(p.canPublish, false);
  assert.deepEqual(p.mcpOff, []);
  assert.deepEqual(p.skillsOff, []);
  assert.deepEqual(p.tools, []);
  assert.equal(personas.forSession({ personaId: 'pe_nowhere' }), undefined);
});

// ── Changing ─────────────────────────────────────────────────────────────────────────

test('update writes the persona whole, one version on, and signals persona.updated after the write', () => {
  const { store, emitted, personas } = rig();
  const a = personas.create({ handle: 'alpha', tools: ['web.fetch'] });
  const next = personas.update(a.id, { description: 'Now reviews.', tools: [] });
  assert.equal(next.version, 2);
  assert.equal(store.state.personas[a.id].description, 'Now reviews.');
  const updated = emitted.filter(([s]) => s === 'persona.updated');
  assert.equal(updated.length, 1);
  const [, data, versionThen] = updated[0];
  assert.equal(versionThen, 2, 'the listeners see the persona as written');
  assert.equal(data.persona, next);
  assert.equal(data.was.version, 1, 'and the persona as it was');
  assert.deepEqual(data.patch.tools, [], 'and what the change named');
});

test('update refuses a persona that doesn’t exist, and signals nothing', () => {
  const { emitted, personas } = rig();
  refused(() => personas.update('pe_nowhere', { description: 'x' }), 404);
  assert.deepEqual(emitted, []);
});

test('update refuses a backend that isn’t registered, and moving a persona in the middle of a turn', () => {
  const { store, emitted, personas } = rig({ midTurn: ['se_1'] });
  const a = personas.create({ handle: 'alpha' });
  refused(() => personas.update(a.id, { backend: 'codex' }), 422);
  store.emit('session', { id: 'se_1', personaId: a.id, threadId: 'th_1', handle: 'alpha' });
  store.emit('host', { id: 'h1', name: 'host.example.com' });
  refused(() => personas.update(a.id, { remote: { hostId: 'h1' } }), 409);
  assert.equal(store.state.personas[a.id].version, 1, 'nothing was written');
  assert.deepEqual(emitted, []);
});

// ── Removing, and what the sheet shows ───────────────────────────────────────────────

test('remove deletes a persona and has each backend forget it; one that doesn’t exist is a 404', async () => {
  const { store, personas, forgets } = rig();
  const a = personas.create({ handle: 'alpha' });
  const { handle, forgotten } = personas.remove(a.id);
  assert.equal(handle, 'alpha');
  assert.equal(store.state.personas[a.id], undefined);
  await forgotten;
  assert.deepEqual(forgets, ['alpha']);
  refused(() => personas.remove(a.id), 404);
});

test('setupFor gives the folder a persona works in: its own, else the project’s', () => {
  const { personas } = rig();
  const own = personas.create({ handle: 'alpha', folder: '/work/alpha' });
  const none = personas.create({ handle: 'beta' });
  assert.equal(personas.setupFor(own.id, 'p1').folder, '/work/alpha');
  assert.equal(personas.setupFor(none.id, 'p1').folder, '/work/p1');
  assert.equal(personas.setupFor(null, null).persona, null);
});
