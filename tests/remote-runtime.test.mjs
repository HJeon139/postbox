// Remote hosts in the runtime and the API (#120, the plan’s L5): where a persona runs, removing a host (its turns stop
// first), `!` staying on this computer for an agent on a host (#67), archive and delete stopping a conversation’s
// turns, each host’s status reaching the page, the host routes behind the page’s token (#74), and noticing that this
// computer woke. The host manager is a fake with the interface server/remote’s has; no process, socket or ssh runs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { tokenFile } from '../server/remote/install.mjs';
import { WAKE_CHECK_MS, WAKE_GAP_MS, watchWake } from '../server/remote/wake.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => {
  for (let i = 0; i < 500 && !fn(); i++) await sleep(2);
  assert.ok(fn(), `Timed out waiting for ${label}`);
};
const tick = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

/** A host manager with the interface the runtime uses, recording what it was asked. */
class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** @type {any[]} */
    this.calls = [];
    /** @type {Map<string, any>} */
    this.statuses = new Map();
    /** @type {Map<string, any>} */
    this.links = new Map();
    this.onForget = (_id) => {};
  }
  status(id) {
    return this.statuses.get(id) ?? null;
  }
  async forget(id) {
    this.calls.push(['forget', id]);
    this.onForget(id);
  }
  /** A link that’s connected, and answers a stop as the daemon does: with the turn’s `ended`, unless answerStops is off. */
  link(id) {
    const link =
      this.links.get(id) ??
      Object.assign(new EventEmitter(), {
        connected: true,
        answerStops: true,
        stops: /** @type {string[]} */ ([]),
        send(msg) {
          if (!this.connected) return false;
          if (msg.type === 'stop') {
            this.stops.push(msg.turn);
            if (this.answerStops) setImmediate(() => this.emit('message', { type: 'ended', turn: msg.turn, exit: { code: null, signal: 'SIGINT' }, size: 0 }));
          }
          return true;
        },
        retry: (o) => this.calls.push(['retry', id, o]),
      });
    this.links.set(id, link);
    return link;
  }
  async refresh(id) {
    this.calls.push(['refresh', id]);
    return false;
  }
  async install(id) {
    this.calls.push(['install', id]);
    return { ok: true, outcome: 'installed' };
  }
  describeInstall(id) {
    return { destination: 'host.example.com', steps: [], text: `Install Postbox’s host program on host.example.com? (${id})` };
  }
  wake() {
    this.calls.push(['wake']);
  }
  need() {}
  release() {}
  async ensureWelcome() {
    return { home: '/home/user', turns: [] };
  }
  async signInCheck() {
    return null;
  }
  async close() {
    this.calls.push(['close']);
  }
}

const REMOTE = { stdin: 'file', env: [], server: 'mcp-config', work: 'events', signInError: null };

/** A backend that can run on a host, whose turns run until they’re stopped; and the mock, which can’t. */
class Held {
  name = 'claude-code';
  capabilities = { remote: REMOTE };
  constructor() {
    /** @type {string[]} */
    this.log = [];
    this.hang = new Set();
    /** Each handle’s last ctx.remote.bring. */
    this.bring = new Map();
  }
  async folderFor(persona, project) {
    return persona.folder || project?.folder || `/work/space/${persona.handle}`;
  }
  async deliver(session, _message, ctx) {
    this.log.push(`start:${session.handle}`);
    this.bring.set(session.handle, ctx.remote?.bring);
    await new Promise((r) => ctx.signal.addEventListener('abort', r, { once: true }));
    this.log.push(`stopped:${session.handle}`);
    // A turn whose process never ends, for the wait’s bound.
    if (this.hang.has(session.handle)) await new Promise(() => {});
  }
}
const mock = { name: 'mock', deliver: async () => {} };

function fakeSpawn() {
  const children = [];
  const spawn = (cmd, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), cmd, args, opts });
    child.kill = () => true;
    child.exit = (code) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
}

function setup({ store = new Store(null), hosts = new FakeHosts() } = {}) {
  const adapter = new Held();
  const { spawn, children } = fakeSpawn();
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter).register(mock),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: '/nowhere', build: { version: '0.10.0' } },
    spawnShell: spawn,
    hosts,
  });
  if (!store.state.projects.p1) store.emit('project', { id: 'p1', name: 'P', folder: '/work/project' });
  return { store, rt, adapter, hosts, children };
}

/** Asserts a runtime call throws the HTTP error with that status, and returns its message. */
function refused(fn, status = 422) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.status, status, e.message);
    return e.message;
  }
  assert.fail('expected a refusal');
}

// ── Where a persona runs ─────────────────────────────────────────────────────────────

test('#120: a persona runs on a host only with a backend that can, and only on a host Postbox knows', () => {
  const { rt } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const p = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  assert.deepEqual(p.remote, { hostId: h.id });
  assert.equal(rt.createPersona({ handle: 'near', backend: 'claude-code' }).remote, null, 'this computer by default');

  assert.match(
    refused(() => rt.createPersona({ handle: 'mocked', backend: 'mock', remote: { hostId: h.id } })),
    /“mock” runs only on this computer, so this agent can’t run on host\.example\.com\. Backends here that can run on a host: claude-code\./,
  );
  assert.match(
    refused(() => rt.createPersona({ handle: 'lost', backend: 'claude-code', remote: { hostId: 'ho_none' } })),
    /That host doesn’t exist/,
  );
  // hostId must be the host’s own, not something on Object’s prototype.
  refused(() => rt.createPersona({ handle: 'proto', backend: 'claude-code', remote: { hostId: 'constructor' } }));
  for (const bad of ['host.example.com', [h.id], { hostId: h.id, folder: '/srv' }, { host: h.id }])
    assert.match(
      refused(() => rt.createPersona({ handle: 'odd', backend: 'claude-code', remote: bad })),
      /null, for this computer, or \{ hostId \}|doesn’t exist/,
    );
  assert.equal(rt.personaByHandle('odd'), undefined, 'a refused persona isn’t stored');

  // Moving it: there and back, and a backend that can’t follow it there.
  const near = rt.personaByHandle('near');
  assert.deepEqual(rt.updatePersona(near.id, { remote: { hostId: h.id } }).remote, { hostId: h.id });
  assert.deepEqual(rt.updatePersona(near.id, { description: 'Builds things' }).remote, { hostId: h.id }, 'other edits keep it');
  assert.match(
    refused(() => rt.updatePersona(near.id, { backend: 'mock' })),
    /“mock” runs only on this computer/,
  );
  assert.equal(rt.persona(near.id).backend, 'claude-code');
  const both = rt.updatePersona(near.id, { backend: 'mock', remote: null });
  assert.deepEqual([both.backend, both.remote], ['mock', null]);
});

test('#120: where a persona runs survives a store reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'postbox-remote-runtime-'));
  try {
    const store = await new Store(dir).load();
    const { rt } = setup({ store });
    const h = rt.addHost({ name: 'host.example.com' });
    const p = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
    const q = rt.createPersona({ handle: 'near', backend: 'claude-code' });
    await store.flush();
    const again = await new Store(dir).load();
    assert.deepEqual(again.state.personas[p.id].remote, { hostId: h.id });
    assert.equal(again.state.personas[q.id].remote, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#120: a persona isn’t moved between this computer and a host in the middle of a turn', async () => {
  const { rt, adapter } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const p = rt.createPersona({ handle: 'dev', backend: 'claude-code' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  rt.sendMessage(t.id, { text: 'go' });
  await until(() => adapter.log.includes('start:dev'), 'the turn');
  assert.match(
    refused(() => rt.updatePersona(p.id, { remote: { hostId: h.id } }), 409),
    /@dev is in the middle of a turn/,
  );
  // The same placement isn’t a move.
  assert.equal(rt.updatePersona(p.id, { remote: null, description: 'x' }).description, 'x');
  for (const se of rt.sessionsIn(t.id)) rt.stop(se.id, { silent: true });
  await until(() => !rt.exiting.size, 'the stop');
  assert.deepEqual(rt.updatePersona(p.id, { remote: { hostId: h.id } }).remote, { hostId: h.id });
});

// ── Removing a host (G10) ───────────────────────────────────────────────────────────

test('#120 G10: removing a host stops its turns first, then forgets its link and token, then removes it', async () => {
  const { rt, adapter, hosts } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const other = rt.addHost({ name: 'other.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const elsewhere = rt.createPersona({ handle: 'elsewhere', backend: 'claude-code', remote: { hostId: other.id } });
  const near = rt.createPersona({ handle: 'near', backend: 'claude-code' });
  const t = rt.createThread({ projectId: 'p1', title: 'Room', personaIds: [far.id, elsewhere.id, near.id] });
  rt.setProjectHostFolder('p1', h.id, '/home/user/app');
  for (const handle of ['far', 'elsewhere', 'near']) rt.sendMessage(t.id, { text: `@${handle} go` });
  await until(() => adapter.log.filter((l) => l.startsWith('start:')).length === 3, 'three turns');

  let atForget = null;
  hosts.onForget = () => {
    atForget = { log: [...adapter.log], exiting: rt.exiting.size, hostKnown: Boolean(rt.s.hosts[h.id]) };
  };
  const r = await rt.removeHost(h.id);
  assert.deepEqual(r, { ok: true, stopped: 1 });
  assert.deepEqual(atForget, { log: [...adapter.log.slice(0, 3), 'stopped:far'], exiting: 0, hostKnown: true }, 'stopped and ended before the forget');
  assert.deepEqual(
    hosts.calls.filter((c) => c[0] === 'forget'),
    [['forget', h.id]],
  );
  assert.equal(rt.s.hosts[h.id], undefined);
  assert.deepEqual(rt.s.projects.p1.hostFolders, {});
  const running = rt
    .sessionsIn(t.id)
    .filter((se) => rt.turns.has(se.id))
    .map((se) => se.handle);
  assert.deepEqual(running.sort(), ['elsewhere', 'near'], 'turns on this computer and other hosts run on');
  for (const se of rt.sessionsIn(t.id)) rt.stop(se.id, { silent: true });
});

test('#120 G10: a stopped turn that never ends holds a host’s removal only for its wait', async () => {
  const { rt, adapter, hosts } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  adapter.hang.add('far');
  rt.sendMessage(t.id, { text: 'go' });
  await until(() => adapter.log.includes('start:far'), 'the turn');
  assert.deepEqual(await rt.removeHost(h.id, { waitMs: 20 }), { ok: true, stopped: 1 });
  assert.deepEqual(hosts.calls, [['forget', h.id]]);
  assert.equal(rt.s.hosts[h.id], undefined);
});

// ── `!` stays on this computer (G6) ─────────────────────────────────────────────────

test('#120 G6: ! for an agent on a host runs in the project’s folder here, never a host path, and says so once', async () => {
  const { rt, store, children } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  // Its own folder names a path on the host: `!` never runs there.
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', folder: '/home/user/app', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  rt.setProjectHostFolder('p1', h.id, '/home/user/app');
  assert.deepEqual(await rt.commandFolder(t.id), { folder: '/work/project', host: 'host.example.com' });
  await rt.runShellCommand(t.id, 'ls');
  assert.equal(children[0].opts.cwd, '/work/project');
  children[0].stdout.write('a\n');
  children[0].stdout.write('b\n');
  children[0].exit(0);
  await tick();
  const it = store.items(t.id).find((i) => i.kind === 'command');
  assert.deepEqual([it.cwd, it.notOn, it.status], ['/work/project', 'host.example.com', 'done']);
  assert.equal(it.text, '! commands run on this computer, not on host.example.com.\na\nb\n');

  // No folder for the project here: the workspace of its own the agent would have on this computer.
  store.emit('project', { ...store.state.projects.p1, folder: '' });
  assert.deepEqual(await rt.commandFolder(t.id), { folder: '/work/space/far', host: 'host.example.com' });
  // An agent on this computer: its own folder, and no note.
  rt.updatePersona(far.id, { remote: null });
  assert.deepEqual(await rt.commandFolder(t.id), { folder: '/home/user/app', host: null });
});

test('#120: a remote turn is told it may post to the conversation only where the laptop’s would: the person’s, in a topic thread', async () => {
  const { rt, adapter } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  rt.sendMessage(t.id, { text: 'go' });
  await until(() => adapter.log.includes('start:far'), 'the conversation’s turn');
  assert.equal(adapter.bring.get('far'), false, 'in the conversation, bring_to_conversation isn’t offered');
  rt.stop(rt.sessionsIn(t.id)[0].id);
  await until(() => adapter.log.includes('stopped:far') && rt.turns.size === 0 && rt.exiting.size === 0, 'stopped');
  const topic = rt.createThread({ projectId: 'p1', title: 'Topic', personaIds: [], kind: 'topic', parentId: t.id });
  rt.sendMessage(topic.id, { text: '@far go on here' });
  await until(() => adapter.log.filter((x) => x === 'start:far').length === 2, 'the topic thread’s turn');
  assert.equal(adapter.bring.get('far'), true, 'in a topic thread, at the person’s message, it is (ctx.remote.bring)');
  rt.stop(rt.sessionsIn(t.id)[0].id);
});

// ── Archive and delete stop a conversation’s turns ─────────────────────────────────

test('#120: archiving a conversation stops its turns on a host, the ones in its topic threads too', async () => {
  const { rt, adapter } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const fork = rt.createPersona({ handle: 'fork', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  const side = rt.createThread({ projectId: 'p1', title: 'Side', personaIds: [fork.id], kind: 'topic', parentId: t.id });
  rt.sendMessage(t.id, { text: 'go' });
  rt.sendMessage(side.id, { text: 'go' });
  await until(() => adapter.log.includes('start:far') && adapter.log.includes('start:fork'), 'two turns');
  // One session per agent per conversation (#228): @fork answers the topic thread from its session in the conversation,
  // so archiving the conversation’s sessions archives it, and stops both turns.
  for (const se of rt.sessionsIn(t.id)) rt.archive(se.id);
  await until(() => adapter.log.includes('stopped:far') && adapter.log.includes('stopped:fork'), 'both stopped');
  assert.equal(rt.turns.size, 0);
  assert.equal(rt.s.threads[t.id].archived, true);
});

test('#120: deleting a conversation stops its turns on a host, its topic threads’ too', async () => {
  const { rt, adapter } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const fork = rt.createPersona({ handle: 'fork', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  const side = rt.createThread({ projectId: 'p1', title: 'Side', personaIds: [fork.id], kind: 'topic', parentId: t.id });
  rt.sendMessage(t.id, { text: 'go' });
  rt.sendMessage(side.id, { text: 'go' });
  await until(() => adapter.log.includes('start:far') && adapter.log.includes('start:fork'), 'two turns');
  rt.deleteThread(t.id);
  await until(() => adapter.log.includes('stopped:far') && adapter.log.includes('stopped:fork'), 'both stopped');
  assert.equal(rt.turns.size, 0);
  rt.undoDeleteThread(t.id);
});

// ── Each host’s status ──────────────────────────────────────────────────────────────

test('#120: each host’s status reaches the state, at each change the manager emits, lastHeard alone too', () => {
  const { rt, store, hosts } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const gone = 'ho_gone';
  // From before a restart: replaced by what the manager says now, and dropped for a host that’s gone.
  store.emit('host.status', { id: h.id, status: { state: 'connected', failure: null, welcome: null, lastHeard: 1 } });
  store.emit('host.status', { id: gone, status: { state: 'connected', failure: null, welcome: null, lastHeard: 1 } });
  hosts.statuses.set(h.id, { state: 'disconnected', failure: null, welcome: null, lastHeard: 1 });
  rt.watchHosts();
  assert.deepEqual(store.state.hostStatus, { [h.id]: { state: 'disconnected', failure: null, welcome: null, lastHeard: 1 } });

  const events = [];
  store.subscribe((ev) => ev.type === 'host.status' && events.push(ev.data));
  const welcome = { version: 2, home: '/home/user', node: { path: '/usr/bin/node', version: 'v22.1.0' }, harnesses: [], problems: [], turns: [{}] };
  hosts.statuses.set(h.id, { state: 'connected', failure: null, welcome, lastHeard: 2 });
  hosts.emit('status', h.id, hosts.statuses.get(h.id));
  assert.deepEqual(events[0].status.welcome, { version: 2, home: '/home/user', node: welcome.node, harnesses: [], problems: [] }, 'not its turns');
  // The manager emits a change to lastHeard alone at most every HEARD_EVERY_MS (server/remote/hosts.mjs): each one
  // it emits reaches the page, and the same status again doesn’t.
  hosts.statuses.set(h.id, { state: 'connected', failure: null, welcome, lastHeard: 3 });
  hosts.emit('status', h.id, hosts.statuses.get(h.id));
  hosts.emit('status', h.id, hosts.statuses.get(h.id));
  assert.equal(events.length, 2, 'lastHeard alone is an event, once');
  assert.equal(events[1].status.lastHeard, 3);
  assert.equal(store.state.hostStatus[h.id].lastHeard, 3);

  // A failure, in words with its next step; an Error’s message is kept, which JSON alone would drop.
  const f = Object.assign(new Error('Sign in to host.example.com.'), { kind: 'sign-in', next: 'Run ssh host.example.com in a terminal.', retry: false });
  hosts.statuses.set(h.id, { state: 'failed', failure: f, welcome, lastHeard: 3 });
  hosts.emit('status', h.id, hosts.statuses.get(h.id));
  assert.deepEqual(store.state.hostStatus[h.id].failure, {
    kind: 'sign-in',
    message: 'Sign in to host.example.com.',
    next: 'Run ssh host.example.com in a terminal.',
    retry: false,
  });
  assert.deepEqual(rt.hostStatus(h.id), store.state.hostStatus[h.id]);

  // A host removed takes its status with it.
  store.emit('host', { id: h.id, removed: true });
  assert.deepEqual(store.state.hostStatus, {});
});

test('#120: without a host manager, status from before a restart is cleared and host actions say why they can’t run', async () => {
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(mock),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [] },
  });
  const h = rt.addHost({ name: 'host.example.com' });
  store.emit('host.status', { id: h.id, status: { state: 'connected', failure: null, welcome: null, lastHeard: 1 } });
  rt.watchHosts();
  assert.deepEqual(store.state.hostStatus, {});
  assert.equal(rt.hostStatus(h.id), null);
  await assert.rejects(rt.installHost(h.id), (e) => e.status === 503 && /wasn’t started with remote hosts/.test(e.message));
  assert.deepEqual(await rt.removeHost(h.id), { ok: true, stopped: 0 });
});

// ── Waking ──────────────────────────────────────────────────────────────────────────

/** A clock and an interval the test moves by hand. */
function fakeClock(t0 = 1_000_000) {
  const c = {
    at: t0,
    /** @type {(() => void) | null} */
    fn: null,
    ms: 0,
    cleared: false,
    now: () => c.at,
    setInterval: (fn, ms) => {
      c.fn = fn;
      c.ms = ms;
      return { unref() {} };
    },
    clearInterval: () => {
      c.cleared = true;
    },
    /** The interval fires `ms` of wall-clock time after the last one. */
    pass(ms) {
      c.at += ms;
      c.fn?.();
    },
  };
  return c;
}

test('#120 D2: a gap over two minutes between 30-second checks means this computer slept, and wakes the hosts', () => {
  const clock = fakeClock();
  const woke = [];
  const stop = watchWake((ms) => woke.push(ms), clock);
  assert.equal(clock.ms, WAKE_CHECK_MS);
  assert.equal(WAKE_CHECK_MS, 30_000);
  assert.equal(WAKE_GAP_MS, 120_000);
  clock.pass(30_000);
  clock.pass(45_000); // a busy event loop, not a sleep
  clock.pass(WAKE_GAP_MS); // exactly the gap isn’t a sleep either
  assert.deepEqual(woke, []);
  clock.pass(3 * 60 * 60_000); // a night’s sleep
  clock.pass(30_000);
  assert.deepEqual(woke, [3 * 60 * 60_000], 'once per wake');
  stop();
  assert.equal(clock.cleared, true);
});

test('#120 D2: a failing wake handler is logged, and the checks go on', () => {
  const clock = fakeClock();
  let n = 0;
  const errors = [];
  const was = console.error;
  console.error = (m) => errors.push(m);
  try {
    watchWake(() => {
      n++;
      throw new Error('boom');
    }, clock);
    clock.pass(10 * 60_000);
    clock.pass(10 * 60_000);
  } finally {
    console.error = was;
  }
  assert.equal(n, 2);
  assert.match(errors[0], /boom/);
});

// ── The routes ──────────────────────────────────────────────────────────────────────

const PORT = 4443;
let app;
let dir;
const fake = new FakeHosts();
const wakeClock = fakeClock();
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
const pageCookie = async () => (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-hosts-'));
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false, hosts: fake, wake: wakeClock });
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  // Stopping the server stops noticing wakes and closes the hosts’ links.
  assert.equal(wakeClock.cleared, true);
  assert.deepEqual(fake.calls.at(-1), ['close']);
});

test('#120: the page adds a host, sets a project’s folder on it, installs, retries, reads its status and removes it', async () => {
  const cookie = await pageCookie();
  const added = await call({ method: 'POST', path: '/api/hosts', body: { name: 'host.example.com', settings: { forwardAgent: false } }, cookie });
  assert.equal(added.status, 201, added.text);
  const id = added.json.id;
  const patched = await call({ method: 'PATCH', path: `/api/hosts/${id}`, body: { settings: { denyPrompts: true } }, cookie });
  assert.equal(patched.json.settings.denyPrompts, true);
  const bad = await call({ method: 'POST', path: '/api/hosts', body: { name: '-oProxyCommand=x' }, cookie });
  assert.equal(bad.status, 422);

  const project = Object.values(app.store.state.projects)[0];
  const folder = await call({ method: 'PUT', path: `/api/projects/${project.id}/hosts/${id}/folder`, body: { folder: '/home/user/app' }, cookie });
  assert.equal(folder.status, 200, folder.text);
  assert.equal(app.store.state.projects[project.id].hostFolders[id], '/home/user/app');
  const relative = await call({ method: 'PUT', path: `/api/projects/${project.id}/hosts/${id}/folder`, body: { folder: 'app' }, cookie });
  assert.equal(relative.status, 422);
  await call({ method: 'PUT', path: `/api/projects/${project.id}/hosts/${id}/folder`, body: { folder: null }, cookie });
  assert.deepEqual(app.store.state.projects[project.id].hostFolders, {});

  // The confirm’s text comes first, by GET, and installing is a write the page makes after it.
  const described = await call({ path: `/api/hosts/${id}/install` });
  assert.match(described.json.text, /^Install Postbox’s host program on host\.example\.com\?/);
  assert.deepEqual(fake.calls, [], 'reading what an install does installs nothing');
  const installed = await call({ method: 'POST', path: `/api/hosts/${id}/install`, body: {}, cookie });
  assert.deepEqual(installed.json, { ok: true, outcome: 'installed' });
  await call({ method: 'POST', path: `/api/hosts/${id}/retry`, body: { takeover: true }, cookie });
  await call({ method: 'POST', path: `/api/hosts/${id}/retry`, body: {}, cookie });
  const odd = await call({ method: 'POST', path: `/api/hosts/${id}/retry`, body: { takeover: 'yes' }, cookie });
  assert.equal(odd.status, 422);
  assert.deepEqual(fake.calls, [
    ['install', id],
    ['retry', id, { takeover: true }],
    ['retry', id, { takeover: false }],
  ]);

  fake.statuses.set(id, { state: 'connected', failure: null, welcome: null, lastHeard: 5 });
  fake.emit('status', id, fake.statuses.get(id));
  assert.deepEqual((await call({ path: `/api/hosts/${id}/status` })).json.status, { state: 'connected', failure: null, welcome: null, lastHeard: 5 });
  const state = await call({ path: '/api/state' });
  assert.equal(state.json.state.hosts[id].name, 'host.example.com');
  assert.equal(state.json.state.hostStatus[id].state, 'connected');

  const removed = await call({ method: 'DELETE', path: `/api/hosts/${id}`, cookie });
  assert.deepEqual(removed.json, { ok: true, stopped: 0 });
  assert.deepEqual(fake.calls.at(-1), ['forget', id]);
  assert.equal((await call({ path: `/api/hosts/${id}/status` })).status, 404);
});

test('#120: the host routes refuse a write without the page’s token, and change nothing', async () => {
  const cookie = await pageCookie();
  const id = (await call({ method: 'POST', path: '/api/hosts', body: { name: 'token.example.com' }, cookie })).json.id;
  const project = Object.values(app.store.state.projects)[0];
  const before = fake.calls.length;
  for (const [method, path, body] of [
    ['POST', '/api/hosts', { name: 'other.example.com' }],
    ['PATCH', `/api/hosts/${id}`, { name: 'renamed.example.com' }],
    ['DELETE', `/api/hosts/${id}`, undefined],
    ['POST', `/api/hosts/${id}/install`, {}],
    ['POST', `/api/hosts/${id}/retry`, {}],
    ['PUT', `/api/projects/${project.id}/hosts/${id}/folder`, { folder: '/srv' }],
  ]) {
    const r = await call({ method, path, body });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.code, 'token');
  }
  assert.equal(fake.calls.length, before, 'no install, retry or forget');
  assert.deepEqual(
    Object.values(app.store.state.hosts).map((h) => h.name),
    ['token.example.com'],
  );
  assert.equal(app.store.state.projects[project.id].hostFolders?.[id], undefined);
});

test('#120 D2: the server wakes its hosts when this computer wakes', async () => {
  wakeClock.pass(30_000);
  assert.equal(fake.calls.filter((c) => c[0] === 'wake').length, 0);
  wakeClock.pass(20 * 60_000);
  assert.equal(fake.calls.filter((c) => c[0] === 'wake').length, 1);
});

test('#120: left out, the server makes the real host manager, keeping tokens in its data folder, and closes it at close', async () => {
  const own = await mkdtemp(join(tmpdir(), 'pb-hosts-own-'));
  const server = await start({ port: PORT + 1, dataDir: own, fresh: true, demo: true, quiet: true, claudeHome: own, listen: false });
  try {
    const hosts = server.rt.hosts;
    assert.equal(typeof hosts?.refresh, 'function', 'server/remote/hosts.mjs’s manager');
    const h = server.rt.addHost({ name: 'host.example.com' });
    assert.equal(server.rt.hostStatus(h.id).state, 'not-installed', 'no token in its data folder yet');
    // A host whose token install.mjs wrote there is installed.
    const h2 = server.rt.addHost({ name: 'other.example.com' });
    await mkdir(join(own, 'remote-tokens'), { recursive: true, mode: 0o700 });
    await writeFile(tokenFile(own, h2.id), 'fake-token-0123456789abcdefghijklmnop\n', { mode: 0o600 });
    assert.equal(server.rt.hostStatus(h2.id).state, 'disconnected', 'installed: its token is in the data folder');
    assert.equal(hosts.link(h2.id), hosts.link(h2.id));
    await server.close();
    assert.throws(() => hosts.link(h2.id), /closed its host connections/);
  } finally {
    await rm(own, { recursive: true, force: true });
  }
});

test('#120: Claude Code, Kiro CLI and Codex are listed without their CLI here, marked not local, and this computer’s list leaves them out', async () => {
  const own = await mkdtemp(join(tmpdir(), 'pb-hosts-probes-'));
  const none = async () => null;
  const nothing = async () => [];
  // Only Claude Code is on this computer; nothing is probed for real.
  const probes = {
    claude: async () => '2.1.296',
    sdk: none,
    kiro: none,
    kiroModels: nothing,
    agy: none,
    agyModels: nothing,
    codex: none,
    codexModels: nothing,
  };
  const server = await start({ port: PORT + 2, dataDir: own, fresh: true, quiet: true, claudeHome: own, listen: false, hosts: new FakeHosts(), probes });
  try {
    const state = await fakeRequest(server.handle, { host: `127.0.0.1:${PORT + 2}`, path: '/api/state' });
    const { adapters, backends } = state.json.config;
    assert.deepEqual(adapters, ['mock', 'claude-code'], 'the backends that run on this computer');
    assert.deepEqual(Object.keys(backends).sort(), ['claude-code', 'codex', 'kiro-cli', 'mock']);
    assert.deepEqual(
      ['mock', 'claude-code', 'kiro-cli', 'codex'].map((n) => backends[n].local),
      [true, true, false, false],
    );
    assert.ok(backends.codex.remote, 'Codex can run on a host');
    const h = server.rt.addHost({ name: 'host.example.com' });
    assert.match(
      refused(() => server.rt.createPersona({ handle: 'near', backend: 'codex' })),
      /^“codex” isn’t available on this computer\. Available: mock, claude-code\. It can run on one of your hosts/,
    );
    assert.deepEqual(server.rt.createPersona({ handle: 'far', backend: 'codex', remote: { hostId: h.id } }).remote, { hostId: h.id });
  } finally {
    await server.close();
    await rm(own, { recursive: true, force: true });
  }
});
