// Remote hosts end to end on the laptop (#120): a real Runtime, the real host manager (server/remote/hosts.mjs) with
// its links and ssh.mjs’s sessions, and the real Claude Code adapter and remote process, over tests/fake-ssh.mjs’s
// spawn wired to tests/fake-daemon.mjs. The stream is the recorded Claude Code turn the fake daemon replays
// (tests/fixtures/claude-code/permission-allow.jsonl, claude 2.1.296 on this computer: no stream recorded on a host
// exists yet). The host’s token is in a temp data folder, as install.mjs writes it. Nothing starts a process or opens
// a connection.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { createHostManager } from '../server/remote/hosts.mjs';
import { tokenFile } from '../server/remote/install.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { createFakeDaemon, FAKE_TOKEN, FIXTURE_PROMPT, fixtureLines } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';

const VERSION = '0.10.0';
const HOST = 'host.example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${label}`);
    await sleep(2);
  }
};

const corpus = { search: (q) => [{ id: 'b1:1', title: 'Found', text: `about ${q}` }], read: () => null, stats: () => ({ books: [], passages: 0 }) };

/** A local kill, ps and spawn that fail the test if they’re ever called: a remote turn uses none of them. */
function forbidden() {
  const calls = [];
  const no =
    (what) =>
    (...a) => {
      calls.push([what, ...a]);
      throw new Error(`A remote turn used this computer’s ${what}.`);
    };
  return { calls, kill: no('kill'), listProcesses: async () => no('ps')(), spawnImpl: no('spawn') };
}

/**
 * A Postbox: a Runtime on `store`, with the real host manager over the fake ssh to `d`. The first one adds the host,
 * writes its token, and places a Claude Code persona on it; a later one (a restart) finds them in the store.
 * @param {{ store?: Store, d?: ReturnType<typeof createFakeDaemon>, dataDir?: string }} [o]
 */
function postbox({ store = new Store(null), d = createFakeDaemon({ autoEnd: false }), dataDir = mkdtempSync(join(tmpdir(), 'pbe-')) } = {}) {
  const ssh = fakeSsh({ daemon: d });
  const f = forbidden();
  const claude = new ClaudeCodeAdapter({
    bin: 'claude',
    workRoot: '/tmp/pb-remote-never',
    spawnImpl: f.spawnImpl,
    kill: f.kill,
    listProcesses: f.listProcesses,
  });
  /** @type {Runtime} */
  let rt;
  const hosts = createHostManager({ getHost: (id) => rt.s.hosts?.[id] ?? null, dataDir, version: VERSION, spawn: ssh.spawn, delay: () => 5 });
  rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(claude),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, build: { version: VERSION } },
    hosts,
  });
  let host = Object.values(store.state.hosts)[0];
  if (!host) {
    store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
    host = rt.addHost({ name: HOST });
    mkdirSync(join(dataDir, 'remote-tokens'), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile(dataDir, host.id), `${FAKE_TOKEN}\n`, { mode: 0o600 });
    const p = rt.createPersona({ handle: 'coder', backend: 'claude-code', remote: { hostId: host.id } });
    store.emit('persona', { ...rt.persona(p.id), permissionMode: 'ask' });
    rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  }
  const t = Object.values(store.state.threads)[0];
  const done = async () => {
    await rt.stopTurns({ graceMs: 50 });
    hosts.close();
  };
  return { rt, store, d, ssh, hosts, host, t, f, dataDir, se: () => rt.sessionsIn(t.id)[0], done };
}

const starts = (d) => d.received.filter((m) => m.type === 'start');
const hellos = (d) => d.received.filter((m) => m.type === 'hello');
/** The session’s replies that count: not the ones a replay replaced. */
const replies = (p) => p.store.items(p.t.id).filter((i) => i.kind === 'agent' && i.sessionId === p.se().id && i.status !== 'replaced');
const BLOCK = { id: 'pick', type: 'choice', version: 1, title: 'Pick', fallback: 'Pick one', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] };

/** Sends a message and waits until its turn runs on the host and is being read. */
async function running(p, text = 'hi') {
  const before = starts(p.d).length;
  p.rt.sendMessage(p.t.id, { text });
  await until(() => starts(p.d).length > before && p.d.turns.has(starts(p.d).at(-1).turn), 'the turn to start on the host');
  const turn = starts(p.d).at(-1).turn;
  await until(() => p.d.received.some((m) => m.type === 'read' && m.turn === turn), 'the turn to be read');
  return turn;
}
/** Until the turn’s whole stream so far is applied: the remote process has acked all of it. */
const applied = (p, turn) => until(() => p.d.turns.get(turn).acked === (p.d.turns.get(turn).out.at(-1)?.next ?? 0), 'the stream to be applied');
const settled = (p) => until(() => !p.rt.turns.size && !p.rt.exiting.size, 'the turn to end');

test('#120 e2e: a remote Claude Code turn streams the host’s lines, shows its block, asks through a card, and ends Done', async () => {
  const p = postbox();
  try {
    const turn = await running(p);
    assert.equal(p.ssh.calls.length, 1, 'one ssh session for the turn');
    assert.equal(p.rt.hostStatus(p.host.id).state, 'connected');
    await applied(p, turn);
    // The recorded stream, applied as the laptop applies a local one.
    assert.match(
      replies(p)
        .map((i) => i.text)
        .join(''),
      /hello\.txt/,
    );
    // A queued show_block from the host’s shim appears once, and the daemon has its reply.
    p.d.tool(turn, 'show_block', { block: BLOCK });
    await until(() => p.d.replies.length === 1, 'the reply');
    assert.equal(p.d.replies[0].ok, true);
    assert.equal(p.store.items(p.t.id).filter((i) => i.kind === 'block' && i.block?.id === 'pick').length, 1);
    // A permission prompt from the host is the laptop’s card; the answer goes back.
    const id = p.d.prompt(turn);
    await until(() => p.store.items(p.t.id).some((i) => i.kind === 'permission' && i.remote?.prompt === id), 'the card');
    const card = p.store.items(p.t.id).find((i) => i.remote?.prompt === id);
    assert.equal(p.se().remoteTurn.state, 'waiting');
    p.rt.resolvePermission(p.t.id, card.id, 'allow');
    await until(() => p.d.answers.length === 1, 'the answer');
    assert.deepEqual(p.d.answers[0], { turn, id, result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
    p.d.end(turn);
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
    const reply = replies(p).filter((i) => i.text);
    assert.equal(reply.length, 1);
    assert.equal(reply[0].status, 'done');
    assert.deepEqual(p.f.calls, [], 'nothing ran on this computer');
  } finally {
    await p.done();
    rmSync(p.dataDir, { recursive: true, force: true });
  }
});

/** The reference for a restart: the reply the recorded stream makes, applied in one go. */
async function inOneGo() {
  const ref = postbox({ d: createFakeDaemon({ autoEnd: false }) });
  try {
    const turn = await running(ref);
    ref.d.end(turn);
    await settled(ref);
    return replies(ref).map((i) => [i.status, i.text]);
  } finally {
    await ref.done();
    rmSync(ref.dataDir, { recursive: true, force: true });
  }
}

/** A Postbox starting up on a store as server/index.mjs does, as far as remote turns go. @param {any} p @param {Store} store */
function startUp(p, store) {
  for (const se of Object.values(store.state.sessions))
    if (['think', 'gen', 'tool', 'stopping'].includes(se.state)) p.rt.updateSession(se.id, { state: 'idle', currentStep: 'Interrupted by a restart' });
  for (const [threadId, list] of Object.entries(store.state.items))
    for (const it of list) if (it.status === 'streaming') p.rt.patchItem(threadId, it.id, { status: 'stopped' });
  p.rt.expireStalePermissions();
  p.rt.restoreRemoteTurns();
  p.rt.watchHosts();
}

test('#120 e2e: Postbox restarts mid-turn, attaches to the turn still on the host, and no line is applied twice', async () => {
  const expected = await inOneGo();

  // The turn has run its command and written part of its reply when Postbox stops.
  const all = fixtureLines();
  const half = all.findIndex((l) => JSON.parse(l).event?.delta?.type === 'text_delta') + 3;
  const d = createFakeDaemon({ autoEnd: false, lines: all.slice(0, half) });
  const store = new Store(null);
  const first = postbox({ store, d });
  const dataDir = first.dataDir;
  let second;
  try {
    const turn = await running(first);
    await applied(first, turn);
    first.d.tool(turn, 'show_block', { block: BLOCK });
    await until(() => d.replies.length === 1, 'the block’s reply');
    assert.ok(
      replies(first).some((i) => i.text),
      'part of the reply showed',
    );
    // Postbox shuts down: the remote turn isn’t stopped, it goes on on the host (stopTurns), and the links close.
    await first.done();
    await until(() => first.ssh.children.every((c) => c.exited), 'its ssh to end');
    await sleep(10); // and the daemon to see its connection close
    assert.deepEqual(d.stops, [], 'the turn on the host wasn’t stopped');
    assert.equal(store.state.sessions[first.se().id].remoteTurn.turn, turn, 'its host turn is kept with the session');
    // Meanwhile the host’s turn writes more.
    for (const line of all.slice(half)) d.append(turn, line);

    // A new Postbox on the same store, starting up as server/index.mjs does.
    second = postbox({ store, d, dataDir });
    startUp(second, store);
    await until(() => d.received.filter((m) => m.type === 'read' && m.turn === turn).length >= 2, 'the attach’s read');
    assert.equal(d.received.filter((m) => m.type === 'read' && m.turn === turn).at(-1).from, 0, 'replayed from the start');
    assert.equal(starts(d).length, 1, 'attached, not started again');
    await applied(second, turn);
    d.end(turn);
    await settled(second);
    // Exactly the reply the stream makes in one go: what showed before the restart was replaced, not added to.
    assert.deepEqual(
      replies(second).map((i) => [i.status, i.text]),
      expected,
    );
    assert.equal(store.items(second.t.id).filter((i) => i.kind === 'block' && i.block?.id === 'pick').length, 1, 'the block once');
    assert.equal(d.replies.length, 1, 'the tool call replied to once');
    assert.equal(second.se().remoteTurn.state, 'done');
    assert.deepEqual(second.f.calls, []);
  } finally {
    await second?.done();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('#120 e2e: a persona whose host was removed is refused with a reason, and never runs on this computer', async () => {
  const p = postbox();
  try {
    assert.deepEqual(await p.rt.removeHost(p.host.id), { ok: true, stopped: 0 });
    // Removing it removed Postbox there, over one session; nothing dials it after.
    assert.equal(p.d.removes, 1);
    assert.equal(p.ssh.calls.length, 1);
    assert.deepEqual(p.rt.persona(p.se().personaId).remote, { hostId: p.host.id }, 'it keeps its placement until moved');
    p.rt.sendMessage(p.t.id, { text: 'hi' });
    await until(() => replies(p).some((i) => i.status === 'failed'), 'the refusal');
    await settled(p);
    const failed = replies(p).find((i) => i.status === 'failed');
    assert.match(failed.error, /@coder’s host was removed, so this turn couldn’t start\. Choose another host for it, or this computer\./);
    assert.deepEqual(p.f.calls, [], 'nothing ran on this computer');
    assert.equal(p.ssh.calls.length, 1, 'nor on any host: no session after the removal’s');
  } finally {
    await p.done();
    rmSync(p.dataDir, { recursive: true, force: true });
  }
});

test('#120 e2e: a change to a setting the daemon enforces reaches a connected host in a fresh hello; others don’t reconnect', async () => {
  const p = postbox();
  try {
    const turn = await running(p);
    await applied(p, turn);
    assert.equal(hellos(p.d).length, 1);
    // stallTimeout stays on the laptop: no new session.
    p.rt.updateHost(p.host.id, { settings: { stallTimeout: 20 * 60_000 } });
    await sleep(30);
    assert.equal(hellos(p.d).length, 1, 'a laptop-only setting doesn’t reconnect');
    // permissionWaitMax is the host’s: a new session, whose hello carries it.
    p.rt.updateHost(p.host.id, { settings: { permissionWaitMax: 2 * 3_600_000 } });
    await until(() => hellos(p.d).length === 2, 'a fresh hello');
    assert.equal(hellos(p.d)[1].settings.permissionWaitMax, 2 * 3_600_000);
    // The turn carries on over the new session.
    await until(() => p.rt.hostStatus(p.host.id).state === 'connected', 'connected again');
    const id = p.d.prompt(turn);
    await until(() => p.store.items(p.t.id).some((i) => i.remote?.prompt === id), 'a card over the new session');
    p.rt.resolvePermission(p.t.id, p.store.items(p.t.id).find((i) => i.remote?.prompt === id).id, 'allow');
    await until(() => p.d.answers.length === 1, 'the answer');
    p.d.end(turn);
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
  } finally {
    await p.done();
    rmSync(p.dataDir, { recursive: true, force: true });
  }
});
