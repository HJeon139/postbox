// The rig for the runtime’s remote turns’ tests (#120, the plan’s L5; tests/remote-turns*.test.mjs): a runtime with a
// persona on a host, over tests/fake-daemon.mjs and a fake host manager, and a Postbox restarted during a turn. Nothing
// here starts a process or opens a connection.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { createMessageReader, encode, MESSAGE_FILE, message, PROTOCOL_VERSION, validateMessage } from '../shared/remote-protocol.mjs';
import { createFakeDaemon, FAKE_TOKEN, FIXTURE_PROMPT } from './fake-daemon.mjs';

export const VERSION = '0.10.0';
export const HOST = 'host.example.com';
export const MIN = 60_000;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (fn, label, tries = 1000) => {
  for (let i = 0; i < tries && !fn(); i++) await sleep(2);
  assert.ok(fn(), `Timed out waiting for ${label}`);
};

/**
 * The host link over the fake daemon’s streams, as server/remote/link.mjs presents it: send() false until a welcome,
 * 'connected' at each welcome, then the daemon’s messages; giveUp() and reconnect() for a link that gave up and a new
 * session.
 * @param {ReturnType<typeof createFakeDaemon>} d
 */
export function fakeLink(d) {
  const link = /** @type {any} */ (new EventEmitter());
  link.setMaxListeners(0);
  link.welcome = null;
  link.connected = false;
  link.sent = [];
  let conn = null;
  const open = (c) => {
    conn = c;
    const reader = createMessageReader('daemon-to-postbox', {
      onMessage(m) {
        if (conn !== c) return;
        if (m.type === 'welcome') {
          link.welcome = m;
          link.connected = true;
          link.emit('connected', m);
        } else if (link.connected) link.emit('message', m);
      },
      onError: (e) => assert.fail(`The fake daemon sent a bad line: ${e.message}`),
    });
    c.stdout.on('data', (b) => setImmediate(() => reader.push(b)));
    c.stdin.write(encode(message('postbox-to-daemon', 'hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN })));
  };
  open({ stdin: d.stdin, stdout: d.stdout });
  link.send = (msg) => {
    if (!link.connected) return false;
    link.sent.push(msg);
    conn.stdin.write(encode(msg));
    return true;
  };
  /** The link gives up, as link.mjs does after a failure it can’t get past: no session, and 'error'. */
  link.giveUp = () => {
    link.connected = false;
    conn = null;
    link.emit('error', new Error('The connection to host.example.com gave up.'));
  };
  /** A new session, on a new connection to the fake daemon: its welcome says 'connected' again. */
  link.reconnect = () => {
    d.drop();
    d.connect();
    open({ stdin: d.stdin, stdout: d.stdout });
  };
  /** A message as the link passes one on, checked as the protocol would. */
  link.hear = (m) => {
    const r = validateMessage('daemon-to-postbox', m);
    assert.ok(r.ok, r.ok ? '' : r.error);
    link.emit('message', m);
  };
  return link;
}

/** The host manager, as server/runtime.mjs uses it, over one fake link. @param {ReturnType<typeof createFakeDaemon>} d */
export function fakeHosts(d, { signIn = /** @type {any} */ (null) } = {}) {
  const link = fakeLink(d);
  const hosts = /** @type {any} */ (new EventEmitter());
  hosts.calls = { need: [], release: [], signIn: 0, ensure: 0, forget: [], refresh: [], remove: [] };
  hosts.signIn = signIn;
  hosts.state = null; // overrides the status’s state
  hosts.theLink = link;
  hosts.link = () => link;
  hosts.ensureWelcome = async () => {
    hosts.calls.ensure++;
    for (let i = 0; i < 500 && !link.connected; i++) await sleep(2);
    if (!link.connected) throw new Error('No welcome from the fake daemon.');
    return link.welcome;
  };
  hosts.status = () => ({ state: hosts.state ?? (link.connected ? 'connected' : 'reconnecting'), failure: null, welcome: link.welcome, lastHeard: null });
  hosts.need = (h, why) => hosts.calls.need.push([h, why]);
  hosts.release = (h, why) => hosts.calls.release.push([h, why]);
  hosts.wake = () => {};
  hosts.signInCheck = async () => {
    hosts.calls.signIn++;
    return hosts.signIn;
  };
  hosts.forget = async (h) => {
    hosts.calls.forget.push(h);
    return true;
  };
  // As the daemon’s `removed` answers it (tests/remote-hosts.test.mjs has the real one).
  hosts.removeFromHost = async (h) => {
    hosts.calls.remove.push(h);
  };
  hosts.refresh = async (h) => {
    hosts.calls.refresh.push(h);
    return false;
  };
  hosts.destinationOf = () => HOST;
  return hosts;
}

/** A local kill, ps and spawn that fail the test if they’re ever called: a remote turn uses none of them. */
export function forbidden() {
  const calls = [];
  return {
    calls,
    kill: (pid, sig) => {
      calls.push(['kill', pid, sig]);
      throw new Error(`The local kill was called with ${pid}, ${sig}.`);
    },
    listProcesses: async () => {
      calls.push(['list']);
      throw new Error('The local ps was read for a remote turn.');
    },
    spawnImpl: (bin) => {
      calls.push(['spawn', bin]);
      throw new Error('A remote turn was spawned on this computer.');
    },
  };
}

export const corpus = { search: (q) => [{ id: 'b1:1', title: 'Found', text: `about ${q}` }], read: () => null, stats: () => ({ books: [], passages: 0 }) };

/**
 * A runtime with one Claude Code persona on a host, over a fake daemon whose turns run until ended (autoEnd false).
 * @param {{ daemon?: object, signIn?: any, store?: Store, settings?: object, d?: any }} [o]
 */
export function rig({ daemon = {}, signIn = null, store = new Store(null), settings = {}, d = createFakeDaemon({ autoEnd: false, ...daemon }) } = {}) {
  const hosts = fakeHosts(d, { signIn });
  const f = forbidden();
  const claude = new ClaudeCodeAdapter({
    bin: 'claude',
    workRoot: '/tmp/pb-remote-never',
    spawnImpl: f.spawnImpl,
    kill: f.kill,
    listProcesses: f.listProcesses,
  });
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(claude),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, build: { version: VERSION } },
    hosts,
  });
  const notes = [];
  store.subscribe((ev) => ev.type === 'notify' && notes.push(ev.data));
  let host = Object.values(store.state.hosts)[0];
  if (!host) {
    store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
    host = rt.addHost({ name: HOST, settings });
    const p = rt.createPersona({ handle: 'coder', backend: 'claude-code' });
    store.emit('persona', { ...rt.persona(p.id), permissionMode: 'ask', remote: { hostId: host.id } });
    rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  }
  const t = Object.values(store.state.threads)[0];
  return { d, hosts, rt, store, t, se: () => rt.sessionsIn(t.id)[0], host, f, notes, link: hosts.theLink };
}

export const starts = (d) => d.received.filter((m) => m.type === 'start');
/** The message Claude Code got on its stdin, for a start. */
export const messageOf = (start) => start.files.find((f) => f.name === MESSAGE_FILE).text;
/** Starts a turn and waits until it runs on the host. */
export async function running(r, text = 'hi') {
  const before = starts(r.d).length;
  r.rt.sendMessage(r.t.id, { text });
  await until(() => starts(r.d).length > before && r.d.turns.has(starts(r.d).at(-1).turn), 'the turn to start on the host');
  const turn = starts(r.d).at(-1).turn;
  await until(() => r.d.received.some((m) => m.type === 'read' && m.turn === turn), 'the turn to be read');
  return turn;
}
export const settled = async (r) => {
  await until(() => !r.rt.turns.size && !r.rt.exiting.size, 'the turn to end');
  await sleep(5);
};

/** A store whose session had a turn running on the host when Postbox stopped, and a card open for its prompt. */
export function restarted({ welcome = /** @type {'running' | 'ended' | 'missing'} */ ('running') } = {}) {
  const store = new Store(null);
  const d = createFakeDaemon({ autoEnd: false });
  const first = rig({ store, d });
  first.rt.remote.close();
  const se = first.se();
  first.rt.updateSession(se.id, {
    backendState: { claudeSessionId: 'e6f7d942-4a4f-4015-b186-0ef8d5c103ca' },
    remoteTurn: { hostId: first.host.id, turn: 'host-turn-1', offset: 120, rtTurn: 'turn_old', threadId: first.t.id, state: 'waiting', at: 1 },
  });
  first.rt.addItem(first.t.id, { kind: 'agent', sessionId: se.id, handle: 'coder', turnId: 'turn_old', text: 'I ran', status: 'streaming' });
  first.rt.addItem(first.t.id, {
    kind: 'permission',
    sessionId: se.id,
    handle: 'coder',
    turnId: 'turn_old',
    tool: 'Bash',
    summary: 'run a command',
    input: FIXTURE_PROMPT.input,
    remote: { hostId: first.host.id, turn: 'host-turn-1', prompt: 'p-1' },
    status: 'open',
  });
  if (welcome !== 'missing') {
    d.addTurn('host-turn-1', { exit: welcome === 'ended' ? { code: 0, signal: null } : null });
    d.prompt('host-turn-1', FIXTURE_PROMPT, 'p-1');
  }
  // The old connection is gone with the old Postbox; the new one connects as the startup in server/index.mjs runs.
  d.drop();
  d.connect();
  return { store, d };
}

/** server/index.mjs’s startup, as far as remote turns go. @param {any} r */
export function startUp(r) {
  for (const [threadId, list] of Object.entries(r.store.state.items))
    for (const it of list) if (it.status === 'streaming') r.rt.patchItem(threadId, it.id, { status: 'stopped' });
  r.rt.expireStalePermissions();
  r.rt.restoreRemoteTurns();
}
