// The runtime’s remote turns (#120, the plan’s L5; server/remote/turns.mjs): a persona on a host runs through the
// real Claude Code adapter and remote process against tests/fake-daemon.mjs, with a fake host manager (the interface
// L5a builds) over the fake daemon’s streams. The stream is the recorded Claude Code turn the fake daemon replays by
// default (tests/fixtures/claude-code/permission-allow.jsonl, claude 2.1.296 on this computer: no stream recorded on a
// host exists yet). Nothing here starts a process or opens a connection.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { KIRO_CAPABILITIES, KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { RemoteTurns, STOPPED_TEXT } from '../server/remote/turns.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { createMessageReader, encode, MESSAGE_FILE, message, PROTOCOL_VERSION, validateMessage } from '../shared/remote-protocol.mjs';
import { createFakeDaemon, FAKE_TOKEN, FIXTURE_PROMPT, fixtureLines } from './fake-daemon.mjs';

const VERSION = '0.10.0';
const HOST = 'host.example.com';
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, tries = 1000) => {
  for (let i = 0; i < tries && !fn(); i++) await sleep(2);
  assert.ok(fn(), `Timed out waiting for ${label}`);
};

/**
 * The host link over the fake daemon’s streams, as server/remote/link.mjs presents it: send() false until a welcome,
 * 'connected' at each welcome, then the daemon’s messages; giveUp() and reconnect() for a link that gave up and a new
 * session.
 * @param {ReturnType<typeof createFakeDaemon>} d
 */
function fakeLink(d) {
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
function fakeHosts(d, { signIn = /** @type {any} */ (null) } = {}) {
  const link = fakeLink(d);
  const hosts = /** @type {any} */ (new EventEmitter());
  hosts.calls = { need: [], release: [], signIn: 0, ensure: 0, forget: [], refresh: [] };
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
  hosts.refresh = async (h) => {
    hosts.calls.refresh.push(h);
    return false;
  };
  hosts.destinationOf = () => HOST;
  return hosts;
}

/** A local kill, ps and spawn that fail the test if they’re ever called: a remote turn uses none of them. */
function forbidden() {
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

const corpus = { search: (q) => [{ id: 'b1:1', title: 'Found', text: `about ${q}` }], read: () => null, stats: () => ({ books: [], passages: 0 }) };

/**
 * A runtime with one Claude Code persona on a host, over a fake daemon whose turns run until ended (autoEnd false).
 * @param {{ daemon?: object, signIn?: any, store?: Store, settings?: object, d?: any }} [o]
 */
function rig({ daemon = {}, signIn = null, store = new Store(null), settings = {}, d = createFakeDaemon({ autoEnd: false, ...daemon }) } = {}) {
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

const starts = (d) => d.received.filter((m) => m.type === 'start');
/** The message Claude Code got on its stdin, for a start. */
const messageOf = (start) => start.files.find((f) => f.name === MESSAGE_FILE).text;
/** Starts a turn and waits until it runs on the host. */
async function running(r, text = 'hi') {
  const before = starts(r.d).length;
  r.rt.sendMessage(r.t.id, { text });
  await until(() => starts(r.d).length > before && r.d.turns.has(starts(r.d).at(-1).turn), 'the turn to start on the host');
  const turn = starts(r.d).at(-1).turn;
  await until(() => r.d.received.some((m) => m.type === 'read' && m.turn === turn), 'the turn to be read');
  return turn;
}
const settled = async (r) => {
  await until(() => !r.rt.turns.size && !r.rt.exiting.size, 'the turn to end');
  await sleep(5);
};

// ── 1. Delivery: welcome, turn ID, snapshot ───────────────────────────────────────────

test('#120 L5: a remote turn gets its host turn ID persisted and the conversation snapshot before start, with the host folder', async () => {
  const r = rig();
  const turn = await running(r);
  const kinds = r.d.received.map((m) => m.type);
  assert.ok(kinds.indexOf('snapshot') < kinds.indexOf('start'), `snapshot before start: ${kinds.join(', ')}`);
  const snap = r.d.received.find((m) => m.type === 'snapshot');
  const start = starts(r.d)[0];
  assert.equal(snap.turn, turn);
  assert.equal(start.turn, turn);
  assert.equal(start.folder, '/home/user/postbox-work/coder');
  // Persisted with the session before anything ran.
  assert.deepEqual(
    { hostId: r.se().remoteTurn.hostId, turn: r.se().remoteTurn.turn, state: r.se().remoteTurn.state },
    { hostId: r.host.id, turn, state: 'running' },
  );
  // The snapshot is read_conversation’s and read_message’s, in the runtime’s own words.
  assert.equal(snap.home, r.t.id);
  assert.deepEqual(
    snap.threads.map((th) => th.id),
    r.rt.conversationThreads(r.t.id),
  );
  const mine = snap.threads[0].items.find((i) => i.line === 'You: hi');
  assert.ok(mine, JSON.stringify(snap.threads[0].items));
  assert.equal(mine.text, r.rt.readLine(r.store.item(r.t.id, mine.id), r.se(), Number.POSITIVE_INFINITY));
  // The host is needed for the turn’s life.
  assert.deepEqual(r.hosts.calls.need, [[r.host.id, 'turn']]);
  assert.equal(r.f.calls.length, 0);
  // Kept current while it runs: a new item goes as snapshot-items. What changed as the turn started (the thread’s
  // lastSpeaker, a full snapshot) goes first, so only the new item is left to send.
  r.rt.remote.flushSnapshots();
  const it = r.rt.addItem(r.t.id, { kind: 'user', text: 'one more thing' });
  r.rt.remote.flushSnapshots();
  await until(() => r.d.turns.get(turn).snapshotItems.length > 0, 'snapshot-items');
  const items = r.d.turns.get(turn).snapshotItems[0];
  assert.equal(items.thread, r.t.id);
  assert.deepEqual(items.items, [{ id: it.id, line: 'You: one more thing', text: 'You: one more thing' }]);
  r.d.end(turn);
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'done');
  assert.deepEqual(r.hosts.calls.release, [[r.host.id, 'turn']]);
  const reply = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.text);
  assert.match(reply.text, /hello\.txt/);
});

test('#120 L5: the project’s folder on the host is the turn’s folder; every item counts in the snapshot, shown or not', async () => {
  const r = rig();
  r.store.emit('project', { ...r.store.state.projects.p1, hostFolders: { [r.host.id]: '/srv/work' } });
  r.rt.addItem(r.t.id, { kind: 'system', variant: 'wake', from: 'you', to: 'coder' });
  r.rt.addItem(r.t.id, { kind: 'agent', sessionId: 'other', handle: 'other', text: '', status: 'failed' });
  const turn = await running(r);
  assert.equal(starts(r.d)[0].folder, '/srv/work');
  const snap = r.d.received.find((m) => m.type === 'snapshot' && m.turn === turn);
  const lines = snap.threads[0].items.map((i) => i.line);
  // The failed reply shows nothing but still counts, as read_conversation counts it when paging.
  assert.ok(lines.includes(''), JSON.stringify(lines));
  assert.ok(lines.includes('You woke @coder'));
  r.d.end(turn);
  await settled(r);
});

// ── 2. The daemon’s tool calls and prompts ───────────────────────────────────────────

test('#120 L5: a queued tool from the host goes through the laptop’s tools once, and is replied to each time it’s sent', async () => {
  const r = rig();
  const turn = await running(r);
  const block = { id: 'pick', type: 'choice', version: 1, title: 'Pick', fallback: 'Pick one', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] };
  const id = r.d.tool(turn, 'show_block', { block });
  await until(() => r.d.replies.length === 1, 'the reply');
  assert.equal(r.d.replies[0].ok, true);
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'block' && i.block?.id === 'pick').length, 1);
  // The daemon sends it again after a hello until it hears the reply: the same reply, and no second block.
  r.link.hear({ type: 'tool', turn, id, name: 'show_block', args: { block } });
  await until(() => r.link.sent.filter((m) => m.type === 'reply' && m.id === id).length === 2, 'the repeat’s reply');
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'block' && i.block?.id === 'pick').length, 1);
  // An asked one gets its answer’s text.
  r.d.tool(turn, 'corpus_search', { query: 'whales' });
  await until(() => r.d.replies.length === 2, 'the search’s reply');
  assert.match(r.d.replies[1].text, /about whales/);
  r.d.end(turn);
  await settled(r);
  // A call from a turn that has ended, heard while the next one runs, is refused, as on the laptop.
  const next = await running(r, 'again');
  r.link.hear({ type: 'tool', turn, id: 'late', name: 'define_term', args: { term: 'x', definition: 'y' } });
  await until(() => r.link.sent.some((m) => m.type === 'reply' && m.id === 'late'), 'the late call’s refusal');
  assert.deepEqual((({ ok, text }) => ({ ok, text }))(r.link.sent.find((m) => m.type === 'reply' && m.id === 'late')), { ok: false, text: STOPPED_TEXT });
  assert.equal(r.store.state.glossary[r.t.id]?.x, undefined);
  r.d.end(next);
  await settled(r);
});

test('#120 L5: a prompt from the host is the laptop’s permission card, and the person’s answer goes back as answer', async () => {
  const r = rig();
  const turn = await running(r);
  const id = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.deepEqual(card.remote, { hostId: r.host.id, turn, prompt: id });
  assert.equal(card.tool, FIXTURE_PROMPT.tool_name);
  assert.equal(r.se().remoteTurn.state, 'waiting');
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.deepEqual(r.d.answers[0], { turn, id, result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  assert.equal(r.se().remoteTurn.state, 'running');
  r.d.end(turn);
  await settled(r);
});

test('#120 L5: a prompt the host expired or the harness canceled marks its card, and no answer goes', async () => {
  const r = rig();
  const turn = await running(r);
  const a = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === a), 'the first card');
  r.d.expire(turn, a);
  await until(() => r.store.items(r.t.id).find((i) => i.remote?.prompt === a).status === 'expired', 'the card expired');
  const b = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === b), 'the second card');
  r.link.hear({ type: 'prompt-expired', turn, id: b, at: 1_760_000_000_000, reason: 'canceled' });
  assert.equal(r.store.items(r.t.id).find((i) => i.remote?.prompt === b).status, 'canceled');
  await sleep(10);
  assert.equal(r.link.sent.filter((m) => m.type === 'answer').length, 0);
  assert.equal(r.se().needs, null);
  r.d.end(turn);
  await settled(r);
});

test('#120 L5 invariant: a prompt-expired for a prompt the person already answered is ignored, and the card keeps its answer', async () => {
  const r = rig();
  const turn = await running(r);
  const id = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === id), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === id);
  r.rt.resolvePermission(r.t.id, card.id, 'deny', { reason: 'not now' });
  await until(() => r.d.answers.length === 1, 'the answer');
  const before = { ...r.store.item(r.t.id, card.id) };
  // The answer raced the host’s expiry: a no-prompt error for it, then the expiry, both tolerated.
  r.link.hear({ type: 'error', code: 'no-prompt', re: 'answer', turn, message: `Prompt ${id} in turn ${turn} isn’t waiting any more.` });
  r.link.hear({ type: 'prompt-expired', turn, id, at: 1_760_000_000_000 });
  r.link.hear({ type: 'prompt-expired', turn, id, at: 1_760_000_000_001, reason: 'canceled' });
  const after = r.store.item(r.t.id, card.id);
  assert.equal(after.status, 'denied');
  assert.equal(after.reason, 'not now');
  assert.equal(after.answeredAt, before.answeredAt);
  assert.equal(r.link.sent.filter((m) => m.type === 'answer').length, 1);
  // A repeat of the prompt (after a hello) gets the same answer again, with no second card.
  r.link.hear({ type: 'prompt', id, turn, request: FIXTURE_PROMPT });
  assert.equal(r.link.sent.filter((m) => m.type === 'answer').length, 2);
  assert.deepEqual(r.link.sent.filter((m) => m.type === 'answer')[1].result, r.link.sent.filter((m) => m.type === 'answer')[0].result);
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'permission').length, 1);
  r.d.end(turn);
  await settled(r);
});

test('#120 L5: an expiry the daemon couldn’t record marks the open card ended', async () => {
  const r = rig();
  const turn = await running(r);
  const id = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === id), 'the card');
  r.link.hear({ type: 'error', code: 'internal', re: 'prompt-expired', turn, message: `Couldn’t write down that prompt ${id} expired.` });
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === id);
  assert.equal(card.status, 'ended');
  await sleep(10);
  assert.equal(r.link.sent.filter((m) => m.type === 'answer').length, 0);
  r.d.end(turn);
  await settled(r);
});

test('#120 L5: an expiry the daemon couldn’t record names its prompt, so exactly that card ends with others open', async () => {
  const r = rig();
  const turn = await running(r);
  const a = r.d.prompt(turn);
  const b = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).filter((i) => i.kind === 'permission').length === 2, 'two cards');
  r.d.expireUnrecorded(turn, b);
  const card = (id) => r.store.items(r.t.id).find((i) => i.remote?.prompt === id);
  await until(() => card(b).status === 'ended', 'the named card to end');
  assert.equal(card(a).status, 'open', 'the other card still waits');
  // The ended one’s repeat (a hello) shows nothing again; the open one is still answered.
  r.link.hear({ type: 'prompt', id: b, turn, request: FIXTURE_PROMPT });
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'permission').length, 2);
  r.rt.resolvePermission(r.t.id, card(a).id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.equal(r.d.answers[0].id, a);
  assert.equal(r.link.sent.filter((m) => m.type === 'answer' && m.prompt === b).length, 0);
  // And one the person already answered keeps its answer when such an error comes late.
  r.link.hear({ type: 'error', code: 'internal', re: 'prompt-expired', turn, id: a, message: 'Couldn’t write it down.' });
  assert.equal(card(a).status, 'allowed');
  r.d.end(turn);
  await settled(r);
});

// ── 3. Turn states ───────────────────────────────────────────────────────────────────

test('#120 L5: a turn quiet for the host’s stallTimeout is Hung: stopped through the daemon, with the last line’s time', async () => {
  const r = rig();
  let now = Date.UTC(2026, 9, 23, 9, 0);
  r.rt.remote.now = () => now;
  const turn = await running(r);
  await until(() => r.d.received.some((m) => m.type === 'ack' && m.turn === turn), 'the stream to be applied');
  now += 14 * MIN;
  r.rt.remote.checkStalls();
  assert.equal(r.d.stops.length, 0, 'not yet quiet for 15 minutes');
  // Waiting on you isn’t hung.
  const id = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === id), 'the card');
  now += 30 * MIN;
  r.rt.remote.checkStalls();
  assert.equal(r.d.stops.length, 0, 'a card is open');
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === id);
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the daemon’s stop');
  await settled(r);
  const last = new Date(Date.UTC(2026, 9, 23, 9, 0)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const text = `Stopped: no output for 15 min (the last at ${last})`;
  assert.equal(r.se().remoteTurn.state, 'hung');
  assert.equal(r.se().currentStep, text);
  assert.ok(r.store.items(r.t.id).some((i) => i.kind === 'agent' && i.note === text));
  assert.ok(r.notes.some((n) => n.text === text));
  assert.equal(r.f.calls.length, 0, 'never the local kill or ps');
});

test('#120 L5: an open tool call is a sign of work for an adapter that prints nothing while one runs (Kiro), not for Claude Code', async () => {
  assert.equal(KIRO_CAPABILITIES.remote.work, 'open-tool-call');
  const r = rig();
  let now = 1_000_000;
  r.rt.remote.now = () => now;
  const turn = await running(r);
  // The whole stream applied first: a line that came after the clock moved would be a sign of life (under load).
  await until(() => r.d.turns.get(turn).acked === r.d.turns.get(turn).out.at(-1).next, 'the stream to be applied');
  const live = r.rt.turns.get(r.se().id).remote;
  assert.equal(live.work, 'events');
  // The rule, as a Kiro turn would have it: a step still running holds off Hung.
  const kiro = new KiroCliAdapter({ bin: 'kiro-cli', workRoot: '/tmp/pb-remote-never', models: [] });
  const other = new RemoteTurns(r.rt);
  live.work = other.begin({ sessionId: 'x', remote: null }, r.host.id, kiro).work;
  other.close();
  assert.equal(live.work, 'open-tool-call');
  // The step itself, not steps[0]: the stream’s own Bash step comes first once it’s applied.
  const step = { id: 's1', label: 'Run the tests', state: 'running' };
  r.rt.turns.get(r.se().id).steps.push(step);
  now += 60 * MIN;
  r.rt.remote.checkStalls();
  assert.equal(r.d.stops.length, 0);
  step.state = 'done';
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop');
  await settled(r);
});

/** The fixture’s stream, ending with the sign-in error the adapter names (capabilities.remote.signInError) instead of
 * its result: no host has recorded one yet, so it’s the recorded result line with those fields. */
const signInLines = () => {
  const lines = fixtureLines();
  const i = lines.findIndex((l) => JSON.parse(l).type === 'result');
  const res = JSON.parse(lines[i]);
  lines[i] = JSON.stringify({ ...res, is_error: true, error: 'authentication_failed', result: 'Failed to authenticate.' });
  return lines.slice(0, i + 1);
};

test('#120 L5: the harness’s sign-in error is Sign-in needed; with no signInCheck it waits for the person’s Resume', async () => {
  const r = rig({ daemon: { lines: signInLines() } });
  const turn = await running(r);
  r.d.end(turn, { code: 1, signal: null });
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'signin');
  const failed = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.match(failed.error, new RegExp(`^Sign-in needed on ${HOST.replace(/\./g, '\\.')}`));
  assert.deepEqual(failed.remote, { state: 'signin', hostId: r.host.id });
  // The host comes back, and time passes: no check, so no resume.
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  r.rt.remote.now = () => Date.now() + 60 * MIN;
  r.rt.remote.tick();
  await sleep(30);
  assert.equal(starts(r.d).length, 1);
  // The person resumes: the turn starts with why the last one stopped.
  r.rt.resumeRemote(r.se().id);
  await until(() => starts(r.d).length === 2, 'the resumed turn');
  const text = messageOf(starts(r.d)[1]);
  assert.match(text, /stopped before it finished, because the sign-in on that host had run out/);
  assert.equal(starts(r.d)[1].env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, undefined);
  r.d.end(starts(r.d)[1].turn);
  await settled(r);
});

test('#120 L5: after Sign-in needed a failed signInCheck never resumes; a passing one does', async () => {
  const r = rig({ daemon: { lines: signInLines() }, signIn: { ok: false, code: 1, at: 1 } });
  const turn = await running(r);
  // The check ran before the turn, and its failure is a warning, not a refusal.
  assert.ok(r.notes.some((n) => n.title === `Sign-in on ${HOST} may have run out`));
  r.d.end(turn, { code: 1, signal: null });
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'signin');
  let now = Date.now();
  r.rt.remote.now = () => now;
  for (let i = 0; i < 4; i++) {
    r.hosts.emit('status', r.host.id, { state: 'connected' });
    now += 10 * MIN;
    r.rt.remote.tick();
    await sleep(10);
  }
  assert.ok(r.hosts.calls.signIn >= 5, `checks run: ${r.hosts.calls.signIn}`);
  assert.equal(starts(r.d).length, 1, 'a failed check never resumes');
  r.hosts.signIn = { ok: true, code: 0, at: 2 };
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await until(() => starts(r.d).length === 2, 'the resumed turn');
  assert.match(messageOf(starts(r.d)[1]), /sign-in on that host had run out/);
  r.d.end(starts(r.d)[1].turn);
  await settled(r);
});

test('#120 L5: Interrupted (no runner, no exit.json) resumes on its own once the host is back, continuing the cut-off turn', async () => {
  const r = rig();
  const turn = await running(r);
  await until(() => r.se().backendState?.claudeSessionId, 'the session ID');
  r.hosts.state = 'reconnecting';
  r.d.interrupt(turn);
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'interrupted');
  const failed = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.match(failed.error, new RegExp(`^Interrupted on ${HOST.replace(/\./g, '\\.')}`));
  await sleep(20);
  assert.equal(starts(r.d).length, 1, 'the host isn’t back yet');
  r.hosts.state = null;
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await until(() => starts(r.d).length === 2, 'the resumed turn');
  const again = starts(r.d)[1];
  assert.equal(again.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, '1');
  assert.ok(again.argv.includes('--resume'));
  assert.match(messageOf(again), /^\[Postbox\] Your last turn on host\.example\.com was interrupted before it finished/);
  r.d.end(again.turn);
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'done');
});

// ── 5. Stop ──────────────────────────────────────────────────────────────────────────

test('#120 L5: Stop on a remote turn is a plain stop: no keep-jobs ask, no keep list, and a job’s own Stop says why not', async () => {
  const r = rig();
  const turn = await running(r);
  const live = r.rt.turns.get(r.se().id);
  r.rt.recordJob(live, { id: 'job1', toolUseId: 'tu_1', label: 'Serve', command: 'npm start', state: 'running' });
  await assert.rejects(r.rt.stopJob(r.se().id, 'job1'), (e) => e.status === 409 && /A job on a host stops with its turn/.test(e.message));
  const res = r.rt.requestStop(r.se().id);
  assert.equal(res.ask, undefined);
  assert.equal(res.stopped, true);
  assert.equal(live.keepJobs.size, 0);
  assert.deepEqual(live.abort.signal.reason.keepJobs, []);
  await until(() => r.d.stops.includes(turn), 'the daemon’s stop');
  await settled(r);
  assert.equal(r.f.calls.length, 0);
  // A stop with jobs: 'keep' that reaches it anyway keeps nothing.
  const t2 = await running(r, 'again');
  r.rt.stop(r.se().id, { jobs: 'keep' });
  await until(() => r.d.stops.includes(t2), 'the second stop');
  await settled(r);
});

// ── 6. A Postbox restart ─────────────────────────────────────────────────────────────

/** A store whose session had a turn running on the host when Postbox stopped, and a card open for its prompt. */
function restarted({ welcome = /** @type {'running' | 'ended' | 'missing'} */ ('running') } = {}) {
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
function startUp(r) {
  for (const [threadId, list] of Object.entries(r.store.state.items))
    for (const it of list) if (it.status === 'streaming') r.rt.patchItem(threadId, it.id, { status: 'stopped' });
  r.rt.expireStalePermissions();
  r.rt.restoreRemoteTurns();
}

test('#120 L5: after a restart a turn still running on the host is attached from offset 0, its card waits again, and the reply is rebuilt', async () => {
  const { store, d } = restarted();
  const r = rig({ store, d });
  startUp(r);
  // The card stays open: the host still has its prompt.
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  assert.equal(card.status, 'open');
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach’s read');
  const read = d.received.find((m) => m.type === 'read' && m.turn === 'host-turn-1' && !m.log);
  assert.equal(read.from, 0);
  assert.equal(starts(d).length, 0, 'attached, not started again');
  const old = r.store.items(r.t.id).find((i) => i.turnId === 'turn_old' && i.kind === 'agent');
  assert.deepEqual({ status: old.status, text: old.text }, { status: 'replaced', text: '' });
  // The prompt the host sent again (held until the attach started) is waited on by its card from before.
  await until(() => r.rt.permissionWaits.has(card.id), 'the card to wait again');
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => d.answers.length === 1, 'the answer');
  assert.deepEqual(d.answers[0], { turn: 'host-turn-1', id: 'p-1', result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  d.end('host-turn-1');
  await settled(r);
  const reply = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'done' && i.text);
  assert.match(reply.text, /hello\.txt/);
  assert.equal(r.se().remoteTurn.state, 'done');
});

test('#120 L5: after a restart a turn the welcome says ended is applied by replaying it', async () => {
  const { store, d } = restarted({ welcome: 'ended' });
  const r = rig({ store, d });
  startUp(r);
  await settled(r);
  await until(() => r.se().remoteTurn.state === 'done', 'the turn to be applied');
  assert.equal(starts(d).length, 0);
  assert.match(r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'done' && i.text).text, /hello\.txt/);
  // Its card’s prompt never came back once the turn was over: it can’t be answered now.
  assert.equal(r.store.items(r.t.id).find((i) => i.kind === 'permission').status, 'expired');
});

test('#120 L5: after a restart a turn the welcome doesn’t list is Interrupted, and resumes once the host is back', async () => {
  const { store, d } = restarted({ welcome: 'missing' });
  const r = rig({ store, d });
  startUp(r);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'Interrupted');
  const failed = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.match(failed.error, /^Interrupted on host\.example\.com: the host has no record of it\.$/);
  await until(() => starts(d).length === 1, 'the resume');
  assert.equal(starts(d)[0].env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, '1');
  assert.match(messageOf(starts(d)[0]), /was interrupted before it finished/);
  d.end(starts(d)[0].turn);
  await settled(r);
});

/**
 * A restart whose attach waits: the host’s welcome is held until open() (ensureWelcome), so the turn is still waiting
 * to be attached again. @param {any} [o]
 */
function waitingAttach(o) {
  const { store, d } = restarted(o);
  const r = rig({ store, d });
  /** @type {() => void} */
  let open = () => {};
  const held = new Promise((res) => {
    open = () => res(undefined);
  });
  const ensure = r.hosts.ensureWelcome;
  r.hosts.ensureWelcome = async (id) => {
    await held;
    return ensure(id);
  };
  startUp(r);
  return { r, d, open };
}
const reads = (d, turn) => d.received.filter((m) => m.type === 'read' && m.turn === turn);

test('#120 G10: removing a host gives up a turn still waiting to be attached after a restart: asked to stop there, never attached', async () => {
  const { r, d, open } = waitingAttach();
  await until(() => r.link.connected, 'the link');
  const se = r.se();
  // Moved off the host since: only the session’s own record (sessionsOn) says its turn is there.
  r.store.emit('persona', { ...r.rt.persona(se.personaId), remote: null });
  assert.deepEqual(r.rt.remote.sessionsOn(r.host.id), [se.id]);
  assert.deepEqual(await r.rt.removeHost(r.host.id, { waitMs: 50 }), { ok: true, stopped: 1 });
  await until(() => d.stops.includes('host-turn-1'), 'the stop on the host');
  assert.equal(r.store.items(r.t.id).find((i) => i.kind === 'permission').status, 'expired', 'its card can’t be answered');
  assert.equal(r.se().remoteTurn.state, 'done');
  assert.equal(r.rt.remote.sessionsOn(r.host.id).length, 0);
  assert.deepEqual(r.hosts.calls.need, r.hosts.calls.release, 'every need released');
  open();
  await sleep(20);
  assert.equal(reads(d, 'host-turn-1').length, 0, 'never attached');
  assert.equal(r.rt.turns.size, 0);
});

test('#120: archiving a conversation gives up its turn still waiting to be attached after a restart', async () => {
  const { r, d, open } = waitingAttach();
  await until(() => r.link.connected, 'the link');
  r.rt.archive(r.se().id);
  await until(() => d.stops.includes('host-turn-1'), 'the stop on the host');
  open();
  await sleep(20);
  assert.equal(reads(d, 'host-turn-1').length, 0, 'never attached');
  assert.equal(r.rt.turns.size, 0);
  assert.equal(r.se().remoteTurn.state, 'done');
});

test('#120 G10: removing a host drops an Interrupted turn’s resume: nothing starts when the host is back', async () => {
  const { store, d } = restarted({ welcome: 'missing' });
  const r = rig({ store, d });
  r.hosts.state = 'reconnecting'; // so it doesn’t resume before the removal
  startUp(r);
  await until(() => r.se().remoteTurn.state === 'interrupted', 'Interrupted');
  assert.ok(r.se().remoteTurn.resume);
  await r.rt.removeHost(r.host.id, { waitMs: 50 });
  assert.equal(r.se().remoteTurn.resume, null);
  r.hosts.state = null;
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await sleep(20);
  assert.equal(starts(d).length, 0, 'no resume');
});

// ── 7. Offsets ───────────────────────────────────────────────────────────────────────

test('#120 L5: the last applied offset goes into the session as acks advance, and at the turn’s end', async () => {
  const r = rig();
  const turn = await running(r);
  await until(() => r.se().remoteTurn.offset > 0, 'an acked offset');
  const size = r.d.turns.get(turn).out.at(-1).next;
  r.d.append(turn, JSON.stringify({ type: 'system', subtype: 'status', status: 'ok' }));
  r.d.end(turn);
  await settled(r);
  assert.equal(r.se().remoteTurn.offset, r.d.turns.get(turn).out.at(-1).next);
  assert.ok(r.se().remoteTurn.offset > size);
});

// ── 8. Stops the daemon confirms, renames, and backends only on a host ─────────────────

test('#120 G10: a turn whose link gave up keeps its host: removing it is refused until the daemon confirms the turn stopped', async () => {
  const r = rig();
  const turn = await running(r);
  r.link.giveUp();
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'lost', 'still on the host, as far as Postbox knows');
  await assert.rejects(r.rt.removeHost(r.host.id, { waitMs: 50 }), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /^host\.example\.com can’t be reached, so its running turns can’t be stopped; Postbox keeps the host until they can be\./);
    return true;
  });
  assert.ok(r.store.state.hosts[r.host.id], 'the host is kept');
  assert.deepEqual(r.hosts.calls.forget, [], 'and its token');
  assert.equal(r.d.turns.get(turn).exit, null, 'the turn runs on there');
  assert.equal(r.se().remoteTurn.state, 'stopping', 'given up, but not done');
  assert.deepEqual(
    r.se().remoteTurn.stopping.map((x) => x.turn),
    [turn],
    'kept for a restart',
  );
  // Back: the stop goes at the welcome, the daemon’s `ended` confirms it, and then the host can go.
  r.link.reconnect();
  await until(() => r.d.stops.includes(turn), 'the stop on the host');
  await until(() => r.se().remoteTurn.state === 'done', 'the stop confirmed');
  assert.deepEqual(r.se().remoteTurn.stopping, []);
  assert.deepEqual(await r.rt.removeHost(r.host.id, { waitMs: 50 }), { ok: true, stopped: 0 });
  assert.deepEqual(r.hosts.calls.forget, [r.host.id]);
  assert.equal(r.store.state.hosts[r.host.id], undefined);
  assert.equal(r.hosts.calls.need.length, r.hosts.calls.release.length, 'every need released');
});

test('#120 G10: after a restart, a stop asked before it and not confirmed is asked again, and a welcome that doesn’t list the turn confirms it', async () => {
  const { store, d } = restarted({ welcome: 'missing' });
  const se = Object.values(store.state.sessions)[0];
  const hostId = Object.values(store.state.hosts)[0].id;
  store.emit('session', { ...se, remoteTurn: { ...se.remoteTurn, state: 'stopping', stopping: [{ turn: 'host-turn-1', hostId, at: 1 }] } });
  const r = rig({ store, d });
  startUp(r);
  await until(() => r.se().remoteTurn.state === 'done', 'the welcome’s word');
  assert.deepEqual(r.se().remoteTurn.stopping, []);
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'agent' && i.status === 'failed').length, 0, 'not Interrupted: it was stopped');
});

test('#120 G10: a no-turn answer to the stop of a turn whose start went unconfirmed before a drop confirms it, since the daemon then refuses that start; the host can go', async () => {
  const r = rig();
  // The start reaches a channel that drops before the daemon has it: on the host it may still arrive.
  const send = r.link.send;
  /** @type {any[]} */
  const held = [];
  r.link.send = (msg) => {
    if (msg.type !== 'start') return send(msg);
    if (!r.link.connected) return false;
    held.push(msg);
    return true;
  };
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => held.length === 1, 'the start');
  const turn = held[0].turn;
  r.link.connected = false;
  r.rt.stop(r.se().id);
  r.link.send = send;
  await until(() => r.se().remoteTurn.stopping?.length === 1, 'the stop asked');
  assert.deepEqual(
    r.se().remoteTurn.stopping.map((x) => [x.turn, x.unconfirmed]),
    [[turn, true]],
    'kept for a restart, with its start unconfirmed',
  );
  // The welcome doesn’t list it, which says nothing while the start may still arrive: the stop goes, and the daemon’s
  // no-turn answer is its word that the turn won’t run there.
  r.link.reconnect();
  await until(() => r.d.sent.some((m) => m.type === 'error' && m.re === 'stop' && m.code === 'no-turn' && m.turn === turn), 'the no-turn answer');
  await settled(r);
  await until(() => r.se().remoteTurn.state === 'done', 'the stop confirmed');
  assert.deepEqual(r.se().remoteTurn.stopping, []);
  assert.equal(r.rt.remote.busyOn(r.host.id), false);
  assert.equal(r.hosts.calls.need.length, r.hosts.calls.release.length, 'every need released');
  assert.deepEqual(await r.rt.removeHost(r.host.id, { waitMs: 50 }), { ok: true, stopped: 0 });
  assert.equal(r.store.state.hosts[r.host.id], undefined);
});

test('#120 G10: Stop on a turn whose start never reached a connected link is done at once: no stop is kept, and the host can be renamed and removed', async () => {
  const r = rig();
  // The link drops after the welcome, just as the start goes: it’s never written, so nothing can be on the host.
  const send = r.link.send;
  r.link.send = (msg) => {
    if (msg.type === 'start') r.link.connected = false;
    return send(msg);
  };
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => !r.link.connected && r.rt.turns.size === 1, 'the start to find the link down');
  await sleep(5);
  r.rt.stop(r.se().id);
  await settled(r);
  assert.equal(starts(r.d).length, 0, 'the start never went');
  assert.deepEqual(r.se().remoteTurn.stopping, [], 'no stop to confirm');
  assert.equal(r.se().remoteTurn.state, 'done');
  assert.equal(r.rt.remote.busyOn(r.host.id), false);
  assert.equal(r.hosts.calls.need.length, r.hosts.calls.release.length, 'the host isn’t kept needed');
  assert.equal(r.rt.updateHost(r.host.id, { name: 'renamed.example.com' }).name, 'renamed.example.com');
  assert.deepEqual(await r.rt.removeHost(r.host.id, { waitMs: 50 }), { ok: true, stopped: 0 });
  assert.equal(r.store.state.hosts[r.host.id], undefined);
  assert.deepEqual(r.d.stops, []);
});

test('#120 G10: a turn whose preparation fails before any start ends done, and no stop goes to the host', async () => {
  // A host without Claude Code: the adapter refuses once the turn has its host turn ID, before its start.
  const r = rig({ daemon: { harnesses: ['codex'] } });
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'the refusal');
  await settled(r);
  assert.match(r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'failed').error, /^Claude Code isn’t installed on the host\./);
  assert.ok(r.se().remoteTurn.turn, 'it had its host turn ID');
  assert.equal(r.se().remoteTurn.state, 'done');
  assert.deepEqual(r.se().remoteTurn.stopping, []);
  assert.equal(starts(r.d).length, 0);
  assert.equal(r.link.sent.filter((m) => m.type === 'stop').length, 0, 'no stop for a turn the host never had');
  assert.equal(r.rt.remote.busyOn(r.host.id), false);
  assert.equal(r.hosts.calls.need.length, r.hosts.calls.release.length, 'every need released');
});

test('#120 G10: a host whose token is gone from this computer isn’t removed while a turn may run there: the stop and the host are kept', async () => {
  const r = rig();
  const turn = await running(r);
  r.link.giveUp();
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'lost');
  // As the host manager does for a host with no token here: no link, and not-installed.
  r.hosts.link = () => {
    throw Object.assign(new Error('This Postbox has no token for it.'), { code: 'not-installed' });
  };
  await assert.rejects(r.rt.removeHost(r.host.id, { waitMs: 50 }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(
      e.message,
      'host.example.com’s token isn’t on this computer any more, so Postbox can’t reach it to stop 1 running turn: @coder. Install Postbox on host.example.com again to stop them, then remove it.',
    );
    return true;
  });
  assert.ok(r.store.state.hosts[r.host.id], 'the host is kept');
  assert.deepEqual(r.hosts.calls.forget, []);
  assert.equal(r.se().remoteTurn.state, 'stopping', 'given up, but not done');
  assert.deepEqual(
    r.se().remoteTurn.stopping.map((x) => x.turn),
    [turn],
    'its stop is kept, for when the host can be reached',
  );
  assert.ok(r.rt.remote.busyOn(r.host.id));
});

/** The rig with a second agent on the host, in a conversation of its own. @param {any} [o] */
function twoOnHost(o) {
  const r = rig(o);
  const p = r.rt.createPersona({ handle: 'helper', backend: 'claude-code', remote: { hostId: r.host.id } });
  const t2 = r.rt.createThread({ projectId: 'p1', title: 'T2', personaIds: [p.id] });
  return { r, t2 };
}

test('#120: a host isn’t renamed while turns run there, here two; once both are over it is, and the manager drops its old link', async () => {
  const { r, t2 } = twoOnHost();
  const first = await running(r);
  r.rt.sendMessage(t2.id, { text: 'hi' });
  await until(() => starts(r.d).length === 2 && r.d.turns.has(starts(r.d)[1].turn), 'the second turn');
  const second = starts(r.d)[1].turn;
  const rename = () => r.rt.updateHost(r.host.id, { name: 'renamed.example.com' });
  assert.throws(rename, (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /^host\.example\.com can’t be renamed while agents’ turns run there or wait to go on there/);
    return true;
  });
  r.d.end(first);
  await until(() => r.rt.turns.size === 1, 'the first turn’s end');
  assert.throws(rename, (e) => e.status === 409, 'one still runs there');
  // Its settings can change meanwhile: only the destination is held.
  assert.equal(r.rt.updateHost(r.host.id, { settings: { stallTimeout: 20 * MIN } }).name, HOST);
  r.d.end(second);
  await settled(r);
  assert.equal(rename().name, 'renamed.example.com');
  assert.deepEqual(r.hosts.calls.refresh, [r.host.id]);
});

test('#120: a turn that would start on a renamed host’s old link is refused, and the turn still running over it is still heard', async () => {
  const { r, t2 } = twoOnHost();
  const first = await running(r);
  // Renamed by hand with a turn running (the manager keeps the old link for it, and link() refuses anything new).
  const busy = () => {
    throw Object.assign(new Error('This host was renamed renamed.example.com, but Postbox is still using host.example.com for it.'), {
      code: 'host-renamed-busy',
    });
  };
  r.hosts.link = busy;
  r.hosts.ensureWelcome = async () => busy();
  r.store.emit('host', { ...r.store.state.hosts[r.host.id], name: 'renamed.example.com' });
  r.rt.sendMessage(t2.id, { text: 'hi' });
  await until(() => r.store.items(t2.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'the refusal');
  const failed = r.store.items(t2.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.match(
    failed.error,
    /^renamed\.example\.com was renamed while Postbox still had turns running on host\.example\.com, so @helper’s turn didn’t start: it would have run on the old machine\./,
  );
  assert.equal(starts(r.d).length, 1, 'nothing new started on the old machine');
  // The first turn is still heard on the old link: its tool call is answered there.
  r.d.tool(first, 'corpus_search', { query: 'whales' });
  await until(() => r.d.replies.length === 1, 'the reply');
  assert.match(r.d.replies[0].text, /about whales/);
  r.d.end(first);
  await settled(r);
});

/**
 * A runtime with Claude Code here, and Codex registered but not here (config.localBackends), over a fake daemon with
 * these harnesses (all three by default).
 * @param {string[]} [harnesses]
 */
function codexOnHostOnly(harnesses) {
  const d = createFakeDaemon({ autoEnd: false, ...(harnesses ? { harnesses } : {}) });
  const hosts = fakeHosts(d);
  const f = forbidden();
  const own = { workRoot: '/tmp/pb-remote-never', spawnImpl: f.spawnImpl, kill: f.kill, listProcesses: f.listProcesses };
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', ...own })).register(new CodexAdapter({ bin: 'codex', ...own })),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, build: { version: VERSION }, localBackends: ['mock', 'claude-code'] },
    hosts,
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  return { d, hosts, rt, store, f, host: rt.addHost({ name: HOST }) };
}

test('#120: Codex with no CLI on this computer runs on a host that has it, and is refused here', async () => {
  const { d, rt, store, f, host } = codexOnHostOnly();
  assert.throws(
    () => rt.createPersona({ handle: 'near', backend: 'codex' }),
    (e) => e.status === 422 && /^“codex” isn’t available on this computer\. Available: claude-code\. It can run on one of your hosts/.test(e.message),
  );
  const p = rt.createPersona({ handle: 'far', backend: 'codex', remote: { hostId: host.id } });
  assert.deepEqual(p.remote, { hostId: host.id });
  assert.throws(
    () => rt.updatePersona(p.id, { remote: null }),
    (e) => e.status === 422 && /“codex” isn’t available on this computer/.test(e.message),
  );
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  rt.sendMessage(t.id, { text: 'hi' });
  await until(() => starts(d).length === 1, 'the turn on the host');
  assert.equal(starts(d)[0].harness, 'codex');
  const se = rt.sessionsIn(t.id)[0];
  // Codex’s app-server on the host, answering each line on the held stdin, in the shapes of
  // tests/fixtures/codex-app-server/turn.jsonl (recorded from a local Codex turn).
  const ft = d.turns.get(starts(d)[0].turn);
  /** @type {any[]} */
  const reqs = [];
  const answer = setInterval(() => {
    while (reqs.length < ft.writes.length) {
      const req = JSON.parse(ft.writes[reqs.length]);
      reqs.push(req);
      if (req.method === 'initialize') d.append(ft.turn, JSON.stringify({ id: req.id, result: { userAgent: 'codex/0' } }));
      else if (req.method === 'thread/start') d.append(ft.turn, JSON.stringify({ id: req.id, result: { thread: { id: 'thr_1' } } }));
      else if (req.method === 'turn/start') {
        d.append(ft.turn, JSON.stringify({ id: req.id, result: { turn: { id: 'turn_1', status: 'inProgress', items: [] } } }));
        d.append(ft.turn, JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thr_1', itemId: 'msg_1', delta: 'Hello from Codex.' } }));
        d.append(ft.turn, JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } }));
      }
    }
  }, 2);
  try {
    await until(() => !rt.turns.size && !rt.exiting.size && reqs.some((r) => r.method === 'turn/start'), 'the turn’s end');
  } finally {
    clearInterval(answer);
  }
  // With no Codex here there’s no model list from its CLI. Claude’s default isn’t a model Codex runs: sent in
  // thread/start or turn/start it fails the turn, so neither names a model and Codex uses its own default.
  const params = (method) => reqs.find((r) => r.method === method)?.params;
  assert.ok(params('thread/start') && !('model' in params('thread/start')), 'thread/start names no model');
  assert.ok(params('turn/start') && !('model' in params('turn/start')), 'turn/start names no model');
  assert.ok(!reqs.some((r) => /claude-/.test(JSON.stringify(r))), 'no Claude model goes to Codex');
  const reply = store.items(t.id).find((i) => i.kind === 'agent');
  assert.equal(reply.status, 'done');
  assert.equal(reply.text, 'Hello from Codex.');
  assert.equal(rt.s.sessions[se.id].remoteTurn.state, 'done', 'its end confirmed');
  assert.equal(p.model, 'auto', 'the persona leaves the model to Codex');
  // One placed here anyway (stored before, say) is refused at its turn, and never spawned here.
  store.emit('persona', { ...rt.persona(p.id), remote: null });
  rt.sendMessage(t.id, { text: 'again' });
  await until(() => store.items(t.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'the refusal');
  assert.match(
    store.items(t.id).find((i) => i.kind === 'agent' && i.status === 'failed').error,
    /^@far’s turn didn’t start: “codex” isn’t available on this computer/,
  );
  assert.equal(starts(d).length, 1);
  assert.deepEqual(f.calls, []);
});

test('#120: a host whose welcome lacks a backend’s harness is refused for it, saying where its daemon looked; one not heard from yet isn’t', async () => {
  const { hosts, rt, host } = codexOnHostOnly(['claude-code']);
  const status = hosts.status;
  hosts.status = () => ({ state: 'reconnecting', failure: null, welcome: null, lastHeard: null });
  assert.deepEqual(rt.createPersona({ handle: 'early', backend: 'codex', remote: { hostId: host.id } }).remote, { hostId: host.id });
  hosts.status = status;
  await until(() => hosts.theLink.connected, 'the welcome');
  assert.throws(
    () => rt.createPersona({ handle: 'late', backend: 'codex', remote: { hostId: host.id } }),
    (e) =>
      e.status === 422 &&
      /^Codex isn’t installed on host\.example\.com, so this agent can’t run there\. Postbox’s daemon looked in \/home\/user\/\.local\/bin, \/usr\/local\/bin\. Install it there, or set codexPath in the host’s settings\.$/.test(
        e.message,
      ),
  );
  assert.deepEqual(
    rt.createPersona({ handle: 'claude', backend: 'claude-code', remote: { hostId: host.id } }).remote,
    { hostId: host.id },
    'it has Claude Code',
  );
});
