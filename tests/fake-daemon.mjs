// An in-process stand-in for the host daemon (#120), speaking shared/remote-protocol.mjs over a pair of streams, so
// the SSH transport and the remote process test without a host. Every message it reads or sends goes through the
// protocol’s validators, so a test that passes here sends what the real daemon accepts.
//
// Its turns replay a recorded Claude Code stream: tests/fixtures/claude-code/permission-allow.jsonl by default (claude
// 2.1.296, a turn that ran a Bash command the person allowed and ended with a result), with the byte offsets the real
// out.jsonl would have. Its default prompt is the first request in tests/fixtures/claude-code/permission-prompts.json.
//
// The API, from a test’s side:
//   const d = createFakeDaemon({ lines, autoEnd, ... })
//   d.stdin, d.stdout      the current connection, as an ssh child’s: Postbox writes to stdin and reads stdout
//   d.connect()            a new connection beside the current one (a reconnect); returns { stdin, stdout }
//   d.drop()               ends the current connection, as a dropped SSH session does; turns go on
//   d.addTurn(turn, opts)  a turn that was already on the host before Postbox connected
//   d.append(turn, text)   a new out.jsonl line, sent to whoever follows the turn
//   d.end(turn, exit?)     the harness exits: exit.json, then `ended` to followers
//   d.tool(turn, name, args, id?) / d.prompt(turn, request?, id?) / d.expire(turn, id)   queue the shim’s events; the
//                          first two return the ID. A shim picks IDs per turn, so two turns may use the same one: the
//                          fake keys what’s waiting by (turn, id), as the real daemon does.
//   d.received, d.sent, d.errors, d.turns, d.stops, d.answers, d.replies   what happened, to assert on
// and readMessages(stream) on Postbox’s side, to await what the daemon sent.

import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createMessageReader, encode, HARNESSES, message, PROTOCOL_VERSION, utf8Bytes } from '../shared/remote-protocol.mjs';

const FIXTURES = new URL('./fixtures/claude-code/', import.meta.url);

/** A token the fake accepts unless given another. */
export const FAKE_TOKEN = 'fake-token-0123456789abcdefghijklmnop';

/** A recorded Claude Code stream’s lines, without their \n. @param {string} [name] */
export function fixtureLines(name = 'permission-allow') {
  return readFileSync(new URL(`${name}.jsonl`, FIXTURES), 'utf8')
    .split('\n')
    .slice(0, -1);
}

/** The permission_prompt arguments Claude Code sent, recorded (permission-prompts.json). */
export const FIXTURE_PROMPT = JSON.parse(readFileSync(new URL('permission-prompts.json', FIXTURES), 'utf8')).prompts[0];

/**
 * @typedef {{ offset: number, next: number, text: string }} Line
 * @typedef {{ turn: string, harness: string, stdin: string, start: object | null, out: Line[], in: Line[],
 *             exit: { code: number | null, signal: string | null, at: number } | null, interrupted: boolean,
 *             acked: number, writes: string[], snapshot: object | null, snapshotItems: object[] }} FakeTurn
 */

/**
 * @param {{ token?: string, lines?: string[], autoEnd?: boolean, exit?: { code: number | null, signal: string | null },
 *           stopExit?: { code: number | null, signal: string | null }, home?: string, now?: () => number,
 *           harnesses?: string[], problems?: { code: string, message: string }[] }} [opts]
 *   lines: what each started turn’s out.jsonl holds (the fixture by default). autoEnd: a started turn has already
 *   exited with `exit` (true by default); false keeps it running until end() or a stop. stopExit: how a stopped turn
 *   ends (SIGINT, C5). harnesses: the ones the host has (all three by default).
 */
export function createFakeDaemon({
  token = FAKE_TOKEN,
  lines = fixtureLines(),
  autoEnd = true,
  exit = { code: 0, signal: null },
  stopExit = { code: null, signal: 'SIGINT' },
  home = '/home/user',
  now = () => 1_760_000_000_000,
  harnesses = [...HARNESSES],
  problems = [],
} = {}) {
  /** @type {Map<string, FakeTurn>} */
  const turns = new Map();
  /** @type {Map<string, object>} snapshots sent before their turn’s start */
  const pending = new Map();
  // What waits for Postbox, keyed by key(turn, id): a prompt’s or a tool call’s identity is both.
  /** @type {Map<string, { turn: string, id: string, name: string, args: object }>} */
  const tools = new Map();
  /** @type {Map<string, { turn: string, id: string, request: object }>} */
  const prompts = new Map();
  /** @type {{ turn: string, id: string, result: object }[]} the answers that reached a waiting prompt */
  const answers = [];
  /** @type {{ turn: string, id: string, ok: boolean, text: string }[]} the replies that reached a queued tool */
  const replies = [];
  const key = (turn, id) => `${turn}\n${id}`;
  const received = [];
  const sent = [];
  const errors = [];
  const stops = [];
  let ids = 0;
  /** @type {Set<Conn>} */
  const conns = new Set();
  /** @type {Conn | null} the connection that said hello and drives the daemon */
  let driver = null;
  /** @type {Conn} */
  let current;

  /** @typedef {{ stdin: PassThrough, stdout: PassThrough, ready: boolean, closed: boolean, follows: Map<string, true> }} Conn */

  const send = (c, type, body) => {
    if (c.closed) return;
    const msg = message('daemon-to-postbox', type, body);
    sent.push(msg);
    c.stdout.write(encode(msg));
  };
  const fail = (c, code, text, re, turn) => send(c, 'error', { code, message: text, ...(re ? { re } : {}), ...(turn ? { turn } : {}) });
  const close = (c) => {
    if (c.closed) return;
    c.closed = true;
    c.follows.clear();
    if (driver === c) driver = null;
    conns.delete(c);
    c.stdout.end();
  };

  const makeTurn = (turn, harness, stdin, outLines) => {
    /** @type {FakeTurn} */
    const t = { turn, harness, stdin, start: null, out: [], in: [], exit: null, interrupted: false, acked: 0, writes: [], snapshot: null, snapshotItems: [] };
    for (const text of outLines) push(t.out, text);
    turns.set(turn, t);
    return t;
  };
  const size = (log) => log.at(-1)?.next ?? 0;
  const push = (log, text) => {
    const offset = size(log);
    const line = { offset, next: offset + utf8Bytes(text) + 1, text };
    log.push(line);
    return line;
  };
  const followers = (turn, log) => [...conns].filter((c) => c.follows.has(`${turn}:${log}`));
  const sendLine = (c, t, log, l) => send(c, 'line', { turn: t.turn, ...(log === 'in' ? { log } : {}), offset: l.offset, next: l.next, text: l.text });
  const sendEnded = (c, t) => send(c, 'ended', { turn: t.turn, exit: t.exit, size: size(t.out) });
  const finish = (t, how) => {
    if (t.exit || t.interrupted) return;
    t.exit = { code: how.code, signal: how.signal, at: now() };
    for (const c of followers(t.turn, 'out')) {
      sendEnded(c, t);
      c.follows.delete(`${t.turn}:out`);
    }
  };
  const turnState = (t) => (t.exit ? 'ended' : t.interrupted ? 'interrupted' : 'running');

  /** What the daemon does with each of Postbox’s messages, once hello has passed. */
  const handlers = {
    start(c, m) {
      if (!harnesses.includes(m.harness)) return fail(c, 'no-harness', `${m.harness} isn’t installed on this host.`, 'start', m.turn);
      if (turns.has(m.turn)) return fail(c, 'turn-exists', `There’s already a turn ${m.turn} on this host.`, 'start', m.turn);
      const t = makeTurn(m.turn, m.harness, m.stdin, lines);
      t.start = m;
      t.snapshot = pending.get(m.turn) ?? null;
      pending.delete(m.turn);
      send(c, 'started', { turn: m.turn });
      if (autoEnd) finish(t, exit);
    },
    snapshot(_c, m) {
      const t = turns.get(m.turn);
      if (t) t.snapshot = m;
      else pending.set(m.turn, m);
    },
    'snapshot-items'(c, m) {
      const t = turns.get(m.turn);
      if (!t) return fail(c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'snapshot-items', m.turn);
      t.snapshotItems.push(m);
    },
    read(c, m) {
      const t = turns.get(m.turn);
      if (!t) return fail(c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'read', m.turn);
      const log = m.log ?? 'out';
      const all = log === 'in' ? t.in : t.out;
      if (m.from !== size(all) && !all.some((l) => l.offset === m.from))
        return fail(c, 'bad-offset', `${m.from} isn’t the start of a line in ${m.turn}’s ${log} log.`, 'read', m.turn);
      for (const l of all) if (l.offset >= m.from) sendLine(c, t, log, l);
      if (log === 'out' && (t.exit || t.interrupted)) sendEnded(c, t);
      else c.follows.set(`${t.turn}:${log}`, true);
    },
    write(c, m) {
      const t = turns.get(m.turn);
      if (!t) return fail(c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'write', m.turn);
      if (t.stdin !== 'held') return fail(c, 'not-held', `Turn ${m.turn}’s stdin isn’t held, so it takes no lines.`, 'write', m.turn);
      if (t.exit || t.interrupted) return fail(c, 'turn-ended', `Turn ${m.turn} has ended.`, 'write', m.turn);
      t.writes.push(m.line);
      const l = push(t.in, m.line);
      send(c, 'written', { turn: t.turn, upTo: l.next });
      for (const f of followers(t.turn, 'in')) sendLine(f, t, 'in', l);
    },
    answer(c, m) {
      if (!prompts.delete(key(m.turn, m.prompt))) return fail(c, 'no-prompt', `Prompt ${m.prompt} of turn ${m.turn} isn’t waiting any more.`, 'answer', m.turn);
      answers.push({ turn: m.turn, id: m.prompt, result: m.result });
    },
    reply(c, m) {
      if (!tools.delete(key(m.turn, m.id))) return fail(c, 'no-tool', `Tool call ${m.id} of turn ${m.turn} isn’t queued.`, 'reply', m.turn);
      replies.push({ turn: m.turn, id: m.id, ok: m.ok, text: m.text });
    },
    stop(c, m) {
      const t = turns.get(m.turn);
      if (!t) return fail(c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'stop', m.turn);
      stops.push(m.turn);
      finish(t, stopExit);
    },
    ack(c, m) {
      const t = turns.get(m.turn);
      if (!t) return fail(c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'ack', m.turn);
      if (m.upTo > size(t.out)) return fail(c, 'bad-offset', `${m.upTo} is past the end of ${m.turn}’s log.`, 'ack', m.turn);
      t.acked = Math.max(t.acked, m.upTo);
    },
    remove(c) {
      for (const t of turns.values()) finish(t, stopExit);
      turns.clear();
      send(c, 'removed', {});
      close(c);
    },
  };

  const hello = (c, m) => {
    if (m.version !== PROTOCOL_VERSION)
      return fail(
        c,
        'version',
        `This host’s daemon speaks protocol ${PROTOCOL_VERSION}, and Postbox sent ${m.version}. Install this Postbox’s version on the host.`,
        'hello',
      );
    if (m.token !== token) return fail(c, 'bad-token', 'The token doesn’t match the host’s. Reinstall Postbox on the host.', 'hello');
    if (driver && driver !== c) {
      if (!m.takeover) return fail(c, 'busy', 'Another Postbox is using this host. Take over to use it from here.', 'hello');
      fail(driver, 'taken-over', 'Another Postbox took over this host.');
      close(driver);
    }
    driver = c;
    c.ready = true;
    send(c, 'welcome', {
      version: PROTOCOL_VERSION,
      home,
      node: { path: '/usr/bin/node', version: 'v22.12.0' },
      harnesses: HARNESSES.map((name) =>
        harnesses.includes(name)
          ? { name, path: `${home}/.local/bin/${name === 'claude-code' ? 'claude' : name}`, version: name === 'claude-code' ? '2.1.296' : null, looked: [] }
          : { name, path: null, version: null, looked: [`${home}/.local/bin`, '/usr/local/bin'] },
      ),
      problems,
      turns: [...turns.values()].map((t) => ({ turn: t.turn, harness: t.harness, state: turnState(t), size: size(t.out), exit: t.exit })),
    });
    for (const q of tools.values()) send(c, 'tool', { turn: q.turn, id: q.id, name: q.name, args: q.args });
    for (const p of prompts.values()) send(c, 'prompt', { id: p.id, turn: p.turn, request: p.request });
  };

  const connect = () => {
    /** @type {Conn} */
    const c = { stdin: new PassThrough(), stdout: new PassThrough(), ready: false, closed: false, follows: new Map() };
    const reader = createMessageReader('postbox-to-daemon', {
      onMessage(m) {
        received.push(m);
        if (m.type === 'hello') return hello(c, m);
        if (!c.ready) return fail(c, 'not-ready', 'Say hello with the host’s token first.', m.type);
        handlers[m.type](c, m);
      },
      onError(e) {
        errors.push(e);
        fail(c, 'bad-message', e.message);
      },
    });
    c.stdin.on('data', (b) => reader.push(b));
    c.stdin.on('end', () => {
      reader.end();
      close(c);
    });
    conns.add(c);
    current = c;
    return { stdin: c.stdin, stdout: c.stdout };
  };
  connect();

  const need = (turn) => {
    const t = turns.get(turn);
    if (!t) throw new Error(`The fake daemon has no turn ${turn}.`);
    return t;
  };
  const toDriver = (fn) => driver && !driver.closed && fn(driver);

  return {
    get stdin() {
      return current.stdin;
    },
    get stdout() {
      return current.stdout;
    },
    connect,
    drop() {
      close(current);
    },
    received,
    sent,
    errors,
    turns,
    stops,
    answers,
    replies,
    /**
     * A turn already on the host: running, ended (with `exit`) or interrupted.
     * @param {string} turn @param {{ harness?: string, stdin?: string, lines?: string[], exit?: { code: number | null, signal: string | null } | null, interrupted?: boolean }} [o]
     */
    addTurn(turn, { harness = 'claude-code', stdin = 'file', lines: l = lines, exit: e = null, interrupted = false } = {}) {
      const t = makeTurn(turn, harness, stdin, l);
      if (e) t.exit = { code: e.code, signal: e.signal, at: now() };
      t.interrupted = interrupted;
      return t;
    },
    /** @param {string} turn @param {string} text */
    append(turn, text) {
      const t = need(turn);
      const l = push(t.out, text);
      for (const c of followers(turn, 'out')) sendLine(c, t, 'out', l);
    },
    /** @param {string} turn @param {{ code: number | null, signal: string | null }} [how] */
    end(turn, how = exit) {
      finish(need(turn), how);
    },
    /** @param {string} turn @param {string} name @param {object} args @param {string} [id]  the shim’s ID; a fresh one by default */
    tool(turn, name, args, id = `tool-${++ids}`) {
      if (tools.has(key(turn, id))) throw new Error(`The fake daemon already has tool call ${id} for turn ${turn}.`);
      tools.set(key(turn, id), { turn, id, name, args });
      toDriver((c) => send(c, 'tool', { turn, id, name, args }));
      return id;
    },
    /** @param {string} turn @param {object} [request] @param {string} [id]  the shim’s ID; a fresh one by default */
    prompt(turn, request = FIXTURE_PROMPT, id = `prompt-${++ids}`) {
      if (prompts.has(key(turn, id))) throw new Error(`The fake daemon already has prompt ${id} for turn ${turn}.`);
      prompts.set(key(turn, id), { turn, id, request });
      toDriver((c) => send(c, 'prompt', { id, turn, request }));
      return id;
    },
    /** The host denied a waiting prompt at permissionWaitMax. @param {string} turn @param {string} id */
    expire(turn, id) {
      if (!prompts.delete(key(turn, id))) throw new Error(`The fake daemon has no prompt ${id} for turn ${turn}.`);
      toDriver((c) => send(c, 'prompt-expired', { id, turn, at: now() }));
    },
    /** What’s still waiting for Postbox, as (turn, id) pairs. */
    get queued() {
      return {
        tools: [...tools.values()].map(({ turn, id }) => ({ turn, id })),
        prompts: [...prompts.values()].map(({ turn, id }) => ({ turn, id })),
      };
    },
  };
}

/**
 * Postbox’s side of the fake: reads the daemon’s messages from a stream, validated.
 * @param {import('node:stream').Readable} stream
 * @returns {{ messages: any[], errors: any[], next: (type: string, timeoutMs?: number) => Promise<any>, ended: Promise<void> }}
 *   next(type) resolves with the first message of that type not already taken by an earlier next(), and rejects if
 *   none comes within timeoutMs (1 s by default), naming what did come.
 */
export function readMessages(stream) {
  const messages = [];
  const errors = [];
  const taken = new Set();
  /** @type {{ type: string, resolve: (m: any) => void, timer: NodeJS.Timeout }[]} */
  const waiting = [];
  const offer = () => {
    for (const w of [...waiting]) {
      const i = messages.findIndex((m, j) => !taken.has(j) && m.type === w.type);
      if (i === -1) continue;
      taken.add(i);
      waiting.splice(waiting.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(messages[i]);
    }
  };
  const reader = createMessageReader('daemon-to-postbox', {
    onMessage(m) {
      messages.push(m);
      offer();
    },
    onError: (e) => errors.push(e),
  });
  stream.on('data', (b) => reader.push(b));
  const ended = new Promise((resolve) =>
    stream.on('end', () => {
      reader.end();
      resolve();
    }),
  );
  return {
    messages,
    errors,
    ended,
    next(type, timeoutMs = 1000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.splice(
            waiting.findIndex((w) => w.timer === timer),
            1,
          );
          reject(new Error(`No ${type} from the fake daemon within ${timeoutMs} ms; it sent ${messages.map((m) => m.type).join(', ') || 'nothing'}.`));
        }, timeoutMs);
        timer.unref();
        waiting.push({ type, resolve, timer });
        offer();
      });
    },
  };
}
