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
//   d.interrupt(turn)      the runner is gone with no exit.json (a reboot, a SIGKILL): `ended` with exit null
//   d.appendIn(turn, text) a new in.jsonl line (a write the daemon made, or one a test plays late), sent to followers
//   d.caughtUp(turn, log)  sends a `caught-up` held back by holdCaughtUp
//   d.tool(turn, name, args, id?) / d.prompt(turn, request?, id?) / d.expire(turn, id)   queue the shim’s events; the
//                          first two return the ID. A shim picks IDs per turn, so two turns may use the same one: the
//                          fake keys what’s waiting by (turn, id), as the real daemon does. d.expireUnrecorded(turn, id)
//                          ends one with the error the daemon sends when it can’t write the end down.
//   d.received, d.sent, d.errors, d.turns, d.stops, d.answers, d.replies   what happened, to assert on
//   d.checks               each signInCheck a `check` ran, as the argv its connection’s hello sent
//   d.removes              how many `remove`s it was sent
// and readMessages(stream) on Postbox’s side, to await what the daemon sent.
//
// The protocol’s side of it is fake-daemon-handlers.mjs, and readMessages is fake-daemon-reader.mjs’s.

import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createMessageReader, HARNESSES } from '../shared/remote-protocol.mjs';
import { close, fail, finish, followers, HANDLERS, hello, key, makeTurn, push, send, sendEnded, sendLine, size } from './fake-daemon-handlers.mjs';

export { readMessages } from './fake-daemon-reader.mjs';

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
 * @typedef {import('./fake-daemon-handlers.mjs').Line} Line
 * @typedef {import('./fake-daemon-handlers.mjs').FakeTurn} FakeTurn
 * @typedef {import('./fake-daemon-handlers.mjs').Conn} Conn
 * @typedef {import('./fake-daemon-handlers.mjs').FakeState} FakeState
 */

/**
 * @param {{ token?: string, lines?: string[], autoEnd?: boolean, exit?: { code: number | null, signal: string | null },
 *           stopExit?: { code: number | null, signal: string | null }, home?: string, now?: () => number,
 *           harnesses?: string[], problems?: { code: string, message: string }[], holdCaughtUp?: ('out' | 'in')[],
 *           check?: (argv: string[]) => { code: number | null } | Promise<{ code: number | null }>,
 *           remove?: 'removed' | 'refuse' | 'silent' | 'drop' }} [opts]
 *   lines: what each started turn’s out.jsonl holds (the fixture by default). autoEnd: a started turn has already
 *   exited with `exit` (true by default); false keeps it running until end() or a stop. stopExit: how a stopped turn
 *   ends (SIGINT, C5). harnesses: the ones the host has (all three by default). holdCaughtUp: logs whose `caught-up`
 *   a read doesn’t send until the test calls caughtUp(), so lines can arrive between a read’s first pass and it.
 *   check: how the host’s signInCheck exits, given the argv hello sent (exit 0 by default); a promise holds the answer.
 *   remove: how `remove` goes: removed (the default, as the real daemon’s: turns stopped, `removed`, closed), refuse
 *   (the daemon’s error when it won’t delete the folder), silent (no answer) or drop (the connection ends first).
 */
export function createFakeDaemon(opts = {}) {
  const d = fakeState(opts);
  connect(d);
  return Object.assign(
    {
      get stdin() {
        return d.current.stdin;
      },
      get stdout() {
        return d.current.stdout;
      },
      connect: () => connect(d),
      drop() {
        close(d, d.current);
      },
      received: d.received,
      sent: d.sent,
      errors: d.errors,
      turns: d.turns,
      stops: d.stops,
      answers: d.answers,
      replies: d.replies,
      checks: d.checks,
      get removes() {
        return d.removes;
      },
      /** What’s still waiting for Postbox, as (turn, id) pairs. */
      get queued() {
        return {
          tools: [...d.tools.values()].map(({ turn, id }) => ({ turn, id })),
          prompts: [...d.prompts.values()].map(({ turn, id }) => ({ turn, id })),
        };
      },
    },
    turnMethods(d),
    shimMethods(d),
  );
}

/** @param {Parameters<typeof createFakeDaemon>[0]} [opts] @returns {FakeState} */
function fakeState({
  token = FAKE_TOKEN,
  lines = fixtureLines(),
  autoEnd = true,
  exit = { code: 0, signal: null },
  stopExit = { code: null, signal: 'SIGINT' },
  home = '/home/user',
  now = () => 1_760_000_000_000,
  harnesses = [...HARNESSES],
  problems = [],
  holdCaughtUp = [],
  check = () => ({ code: 0 }),
  remove: removing = 'removed',
} = {}) {
  return {
    token,
    lines,
    autoEnd,
    exit,
    stopExit,
    home,
    now,
    harnesses,
    problems,
    holdCaughtUp,
    check,
    removing,
    turns: new Map(),
    pending: new Map(),
    tools: new Map(),
    prompts: new Map(),
    answers: [],
    replies: [],
    received: [],
    sent: [],
    errors: [],
    stops: [],
    checks: [],
    removes: 0,
    ids: 0,
    conns: new Set(),
    driver: null,
    current: /** @type {any} */ (null),
  };
}

/** A new connection beside the current one, which becomes the current one. @param {FakeState} d */
function connect(d) {
  /** @type {Conn} */
  const c = { stdin: new PassThrough(), stdout: new PassThrough(), ready: false, closed: false, follows: new Map() };
  const reader = createMessageReader('postbox-to-daemon', {
    onMessage(m) {
      d.received.push(m);
      if (m.type === 'hello') return hello(d, c, m);
      if (!c.ready) return fail(d, c, 'not-ready', 'Say hello with the host’s token first.', m.type);
      HANDLERS[m.type](d, c, m);
    },
    onError(e) {
      d.errors.push(e);
      fail(d, c, 'bad-message', e.message);
    },
  });
  c.stdin.on('data', (b) => reader.push(b));
  c.stdin.on('end', () => {
    reader.end();
    close(d, c);
  });
  d.conns.add(c);
  d.current = c;
  return { stdin: c.stdin, stdout: c.stdout };
}

/** @param {FakeState} d @param {string} turn */
function need(d, turn) {
  const t = d.turns.get(turn);
  if (!t) throw new Error(`The fake daemon has no turn ${turn}.`);
  return t;
}

/** @param {FakeState} d @param {(c: Conn) => void} fn */
const toDriver = (d, fn) => d.driver && !d.driver.closed && fn(d.driver);

/** What a test does to the fake’s turns. @param {FakeState} d */
function turnMethods(d) {
  return {
    /**
     * A turn already on the host: running, ended (with `exit`) or interrupted.
     * @param {string} turn @param {{ harness?: string, stdin?: string, lines?: string[], exit?: { code: number | null, signal: string | null } | null, interrupted?: boolean }} [o]
     */
    addTurn(turn, { harness = 'claude-code', stdin = 'file', lines: l = d.lines, exit: e = null, interrupted = false } = {}) {
      const t = makeTurn(d, turn, harness, stdin, l);
      if (e) t.exit = { code: e.code, signal: e.signal, at: d.now() };
      t.interrupted = interrupted;
      return t;
    },
    /** @param {string} turn @param {string} text */
    append(turn, text) {
      const t = need(d, turn);
      const l = push(t.out, text);
      for (const c of followers(d, turn, 'out')) sendLine(d, c, t, 'out', l);
    },
    /** @param {string} turn @param {string} text */
    appendIn(turn, text) {
      const t = need(d, turn);
      const l = push(t.in, text);
      for (const c of followers(d, turn, 'in')) sendLine(d, c, t, 'in', l);
    },
    /** Sends the `caught-up` a read held back (holdCaughtUp), at the log’s size now. @param {string} turn @param {'out' | 'in'} log */
    caughtUp(turn, log) {
      const t = need(d, turn);
      for (const c of d.conns) {
        const i = (c.held ?? []).findIndex((h) => h.turn === turn && h.log === log);
        if (i === -1) continue;
        c.held.splice(i, 1);
        send(d, c, 'caught-up', { turn, log, size: size(log === 'in' ? t.in : t.out) });
      }
    },
    /** @param {string} turn @param {{ code: number | null, signal: string | null }} [how] */
    end(turn, how = d.exit) {
      finish(d, need(d, turn), how);
    },
    /** @param {string} turn */
    interrupt(turn) {
      const t = need(d, turn);
      if (t.exit || t.interrupted) return;
      t.interrupted = true;
      for (const c of followers(d, turn, 'out')) {
        sendEnded(d, c, t);
        c.follows.delete(`${turn}:out`);
      }
    },
  };
}

/** What a test has the fake’s shims do. @param {FakeState} d */
function shimMethods(d) {
  return {
    /** @param {string} turn @param {string} name @param {object} args @param {string} [id]  the shim’s ID; a fresh one by default */
    tool(turn, name, args, id = `tool-${++d.ids}`) {
      if (d.tools.has(key(turn, id))) throw new Error(`The fake daemon already has tool call ${id} for turn ${turn}.`);
      d.tools.set(key(turn, id), { turn, id, name, args });
      toDriver(d, (c) => send(d, c, 'tool', { turn, id, name, args }));
      return id;
    },
    /** @param {string} turn @param {object} [request] @param {string} [id]  the shim’s ID; a fresh one by default */
    prompt(turn, request = FIXTURE_PROMPT, id = `prompt-${++d.ids}`) {
      if (d.prompts.has(key(turn, id))) throw new Error(`The fake daemon already has prompt ${id} for turn ${turn}.`);
      d.prompts.set(key(turn, id), { turn, id, request });
      toDriver(d, (c) => send(d, c, 'prompt', { id, turn, request }));
      return id;
    },
    /** The host denied a waiting prompt at permissionWaitMax. @param {string} turn @param {string} id */
    expire(turn, id) {
      if (!d.prompts.delete(key(turn, id))) throw new Error(`The fake daemon has no prompt ${id} for turn ${turn}.`);
      toDriver(d, (c) => send(d, c, 'prompt-expired', { id, turn, at: d.now() }));
    },
    /**
     * A waiting prompt ended, but the daemon couldn’t write that down (the broker’s endPrompt): Postbox hears an error
     * naming the prompt, not prompt-expired. @param {string} turn @param {string} id
     */
    expireUnrecorded(turn, id) {
      if (!d.prompts.delete(key(turn, id))) throw new Error(`The fake daemon has no prompt ${id} for turn ${turn}.`);
      toDriver(d, (c) =>
        send(d, c, 'error', { code: 'internal', re: 'prompt-expired', turn, id, message: `Couldn’t write down that prompt ${id} in turn ${turn} expired.` }),
      );
    },
  };
}
