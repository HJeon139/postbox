// Placement’s interface (designs/architecture/services.md, “Placement”): where a persona’s backend runs, here or on one
// of the person’s hosts (#120), and whether a persona may move. Built on small fakes: a store over a plain state, the
// adapter registry, a host manager that reports welcomes, and a set of sessions in the middle of a turn. It never
// builds Runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Placement } from '../server/remote/placement.mjs';

const HOST = { id: 'h1', name: 'host.example.com' };

/**
 * A Placement over fakes. `here` names the backends registered to run here, `hostOnly` those registered for hosts
 * only, and `remote` those that can run on a host; `midTurn` the sessions with a turn running or still exiting.
 * @param {{ here?: string[], hostOnly?: string[], remote?: string[], midTurn?: string[], sessions?: object, hosts?: object, welcome?: any, folderFor?: Function }} [o]
 */
function rig({
  here = ['mock', 'claude-code'],
  hostOnly = [],
  remote = ['claude-code', 'codex'],
  midTurn = [],
  sessions = {},
  hosts = { h1: HOST },
  welcome,
  folderFor,
} = {}) {
  const adapters = new AdapterRegistry();
  const adapter = (name) => ({ name, capabilities: { remote: remote.includes(name) }, ...(folderFor ? { folderFor } : {}) });
  for (const name of here) adapters.register(adapter(name));
  for (const name of hostOnly) adapters.register(adapter(name), { here: false });
  const store = { state: { hosts, sessions } };
  const busy = new Set(midTurn);
  const hostManager = { status: () => (welcome === undefined ? undefined : { welcome }) };
  return new Placement({ store, midTurn: (id) => busy.has(id), adapters, hosts: hostManager });
}

/** Asserts that `fn` throws an HTTP error with that status, and returns its message. */
function refusal(fn, status) {
  let message = '';
  assert.throws(fn, (/** @type {any} */ e) => {
    assert.equal(e.status, status);
    message = e.message;
    return true;
  });
  return message;
}

// ── Which backends run here ──────────────────────────────────────────────────────────

test('localBackends lists the backends registered here, leaving out those registered for hosts only', () => {
  assert.deepEqual(rig({ here: ['mock'], hostOnly: ['codex'] }).localBackends(), ['mock']);
});

test('runsHere is true for a backend registered here, false for one registered for hosts only or not at all', () => {
  const p = rig({ here: ['mock'], hostOnly: ['codex'] });
  assert.equal(p.runsHere('mock'), true);
  assert.equal(p.runsHere('codex'), false);
  assert.equal(p.runsHere('kiro-cli'), false);
});

test('notHere names the backends that run here, and offers a host only for a backend that can run on one', () => {
  const p = rig({ here: ['mock'], hostOnly: ['codex'], remote: ['codex'] });
  assert.equal(
    p.notHere('codex'),
    '“codex” isn’t available on this computer. Available: mock. It can run on one of your hosts: choose one for this agent. See README, “Run real agents”.',
  );
  assert.equal(p.notHere('nope'), '“nope” isn’t available on this computer. Available: mock. See README, “Run real agents”.');
});

// ── Where a persona runs ─────────────────────────────────────────────────────────────

test('placement is null, this computer, for a remote of null or undefined', () => {
  const p = rig();
  assert.equal(p.placement(null, 'claude-code'), null);
  assert.equal(p.placement(undefined, 'claude-code'), null);
});

test('placement is { hostId } for a host Postbox knows and a backend that can run there', () => {
  assert.deepEqual(rig().placement({ hostId: 'h1' }, 'claude-code'), { hostId: 'h1' });
});

test('placement refuses a remote that isn’t { hostId }', () => {
  const p = rig();
  for (const remote of ['h1', ['h1'], { hostId: 'h1', more: 1 }])
    assert.match(
      refusal(() => p.placement(remote, 'claude-code'), 422),
      /null, for this computer, or \{ hostId \}/,
    );
});

test('placement refuses a host Postbox doesn’t know, including one named for an inherited key', () => {
  const p = rig();
  for (const hostId of ['h2', 'constructor'])
    assert.match(
      refusal(() => p.placement({ hostId }, 'claude-code'), 422),
      /That host doesn’t exist/,
    );
});

test('placement refuses a backend that isn’t registered, naming the host', () => {
  assert.equal(
    refusal(() => rig().placement({ hostId: 'h1' }, 'kiro-cli'), 422),
    '“kiro-cli” isn’t available in this Postbox, so it can’t run on host.example.com either.',
  );
});

test('placement refuses a backend that runs only here, naming those that can run on a host', () => {
  assert.equal(
    refusal(() => rig().placement({ hostId: 'h1' }, 'mock'), 422),
    '“mock” runs only on this computer, so this agent can’t run on host.example.com. Backends here that can run on a host: claude-code.',
  );
});

test('placement refuses a harness the host’s last welcome says isn’t installed, and allows one it found', () => {
  const missing = rig({ welcome: { harnesses: [{ name: 'claude-code', path: null }] } });
  assert.equal(
    refusal(() => missing.placement({ hostId: 'h1' }, 'claude-code'), 422),
    'Claude Code isn’t installed on host.example.com, so this agent can’t run there. Install it there, or set claudePath in the host’s settings.',
  );
  const found = rig({ welcome: { harnesses: [{ name: 'claude-code', path: '/usr/bin/claude' }] } });
  assert.deepEqual(found.placement({ hostId: 'h1' }, 'claude-code'), { hostId: 'h1' });
});

// ── Whether a persona may move ───────────────────────────────────────────────────────

const SESSIONS = { s1: { id: 's1', personaId: 'pe1' }, s2: { id: 's2', personaId: 'pe2' } };
const HERE = { id: 'pe1', handle: 'coder', backend: 'claude-code', remote: null };

test('placedPatch refuses moving a persona while one of its sessions is in the middle of a turn', () => {
  const p = rig({ sessions: SESSIONS, midTurn: ['s1'] });
  assert.equal(
    refusal(() => p.placedPatch('pe1', HERE, { remote: { hostId: 'h1' } }), 409),
    '@coder is in the middle of a turn. Stop it or let it finish, then move it.',
  );
});

test('placedPatch moves a persona whose sessions are idle, though another persona’s is in a turn', () => {
  const p = rig({ sessions: SESSIONS, midTurn: ['s2'] });
  assert.deepEqual(p.placedPatch('pe1', HERE, { remote: { hostId: 'h1' } }), { remote: { hostId: 'h1' } });
});

test('placedPatch lets a persona in a turn change its backend when where it runs stays the same', () => {
  const p = rig({ hostOnly: ['codex'], sessions: SESSIONS, midTurn: ['s1'] });
  const onHost = { ...HERE, remote: { hostId: 'h1' } };
  assert.deepEqual(p.placedPatch('pe1', onHost, { backend: 'codex' }), { backend: 'codex', remote: { hostId: 'h1' } });
});

test('placedPatch refuses a backend that doesn’t run here for a persona placed here', () => {
  const p = rig({ here: ['mock'], hostOnly: ['claude-code'], sessions: SESSIONS });
  assert.match(
    refusal(() => p.placedPatch('pe1', { ...HERE, backend: 'mock' }, { backend: 'claude-code' }), 422),
    /^“claude-code” isn’t available on this computer/,
  );
  assert.match(
    refusal(() => p.placedPatch('pe1', { ...HERE, remote: { hostId: 'h1' } }, { remote: null }), 422),
    /^“claude-code” isn’t available on this computer/,
  );
});

test('placedPatch leaves a patch that changes neither backend nor place as it is', () => {
  const patch = { description: 'd' };
  assert.equal(rig({ sessions: SESSIONS, midTurn: ['s1'] }).placedPatch('pe1', HERE, patch), patch);
});

// ── A persona’s adapter ──────────────────────────────────────────────────────────────

test('registeredAdapter is the persona’s backend’s adapter, the mock’s when it names none, or null', () => {
  const p = rig();
  assert.equal(p.registeredAdapter({ backend: 'claude-code' })?.name, 'claude-code');
  assert.equal(p.registeredAdapter({})?.name, 'mock');
  assert.equal(p.registeredAdapter({ backend: 'kiro-cli' }), null);
});

test('requestAdapter refuses a request about a persona whose backend isn’t registered, with the reason', () => {
  const p = rig();
  assert.equal(p.requestAdapter('coder', { backend: 'claude-code' })?.name, 'claude-code');
  assert.equal(
    refusal(() => p.requestAdapter('coder', { backend: 'kiro-cli' }), 422),
    '@coder’s Kiro CLI isn’t available on this computer. Install it and restart Postbox, or change this agent’s backend.',
  );
});

test('refuseHere fails a turn here whose backend is registered for hosts only, for the person to read', () => {
  const p = rig({ here: ['mock'], hostOnly: ['codex'] });
  assert.doesNotThrow(() => p.refuseHere({ handle: 'coder' }, { backend: 'mock' }));
  assert.throws(() => p.refuseHere({ handle: 'coder' }, { backend: 'codex' }), {
    userMessage: `@coder’s turn didn’t start: ${p.notHere('codex')}`,
  });
});

test('refuseUnregisteredSend refuses a message that would wake an agent whose backend isn’t registered', () => {
  const p = rig();
  assert.doesNotThrow(() => p.refuseUnregisteredSend([{ handle: 'a', backend: 'mock' }]));
  assert.equal(
    refusal(
      () =>
        p.refuseUnregisteredSend([
          { handle: 'a', backend: 'mock' },
          { handle: 'b', backend: 'codex' },
        ]),
      422,
    ),
    '@b’s turn didn’t start: Codex isn’t available on this computer. Install it and restart Postbox, or change this agent’s backend.',
  );
});

// ── Hosts ────────────────────────────────────────────────────────────────────────────

test('hereFolder runs a host agent’s ! commands in the folder it would have here, never its own on the host', async () => {
  /** @type {any[]} */
  const asked = [];
  const folderFor = async (persona, project) => {
    asked.push([persona.folder, project.folder]);
    return '/here/work';
  };
  const p = rig({ folderFor });
  const persona = { handle: 'coder', folder: '/on/host', remote: { hostId: 'h1' } };
  const adapter = p.registeredAdapter({ backend: 'claude-code' });
  assert.deepEqual(await p.hereFolder(persona, { folder: '/proj' }, adapter), { folder: '/here/work', host: 'host.example.com' });
  assert.deepEqual(asked, [['', '/proj']]);
});

test('hereFolder falls back to the project’s folder, and names a host that’s gone “its host”', async () => {
  const p = rig({ hosts: {} });
  assert.deepEqual(await p.hereFolder({ remote: { hostId: 'h1' } }, { folder: '/proj' }, null), { folder: '/proj', host: 'its host' });
  assert.deepEqual(await p.hereFolder({ remote: { hostId: 'h1' } }, null, null), { folder: null, host: 'its host' });
});

test('hostOf is the host a persona runs on, or null for this computer', () => {
  const p = rig();
  assert.equal(p.hostOf({ remote: { hostId: 'h1' } }), 'h1');
  assert.equal(p.hostOf({ remote: null }), null);
  assert.equal(p.hostOf({ remote: { hostId: '' } }), null);
  assert.equal(p.hostOf(undefined), null);
});
