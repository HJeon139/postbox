// The fake daemon’s side of the protocol (tests/fake-daemon.mjs, whose header is its API): hello, then what it does
// with each of Postbox’s messages, and the turns’ logs it reads them from. Every function takes the fake’s state
// first, `d` (FakeState).

import { encode, HARNESSES, message, PROTOCOL_VERSION, utf8Bytes } from '../shared/remote-protocol.mjs';

/**
 * @typedef {{ offset: number, next: number, text: string }} Line
 * @typedef {{ turn: string, harness: string, stdin: string, start: object | null, out: Line[], in: Line[],
 *             exit: { code: number | null, signal: string | null, at: number } | null, interrupted: boolean,
 *             acked: number, writes: string[], snapshot: object | null, snapshotItems: object[] }} FakeTurn
 * @typedef {{ stdin: import('node:stream').PassThrough, stdout: import('node:stream').PassThrough, ready: boolean,
 *             closed: boolean, follows: Map<string, true>, held?: { turn: string, log: string }[], settings?: any }} Conn
 */

/**
 * The fake’s state: createFakeDaemon’s options, and what it holds and records.
 * @typedef {{ token: string, lines: string[], autoEnd: boolean, exit: { code: number | null, signal: string | null },
 *   stopExit: { code: number | null, signal: string | null }, home: string, now: () => number, harnesses: string[],
 *   problems: { code: string, message: string }[], holdCaughtUp: string[],
 *   check: (argv: string[]) => { code: number | null } | Promise<{ code: number | null }>, removing: string,
 *   turns: Map<string, FakeTurn>, pending: Map<string, object>,
 *   tools: Map<string, { turn: string, id: string, name: string, args: object }>,
 *   prompts: Map<string, { turn: string, id: string, request: object }>,
 *   answers: { turn: string, id: string, result: object }[], replies: { turn: string, id: string, ok: boolean, text: string }[],
 *   received: any[], sent: any[], errors: any[], stops: string[], checks: string[][], removes: number, ids: number,
 *   conns: Set<Conn>, driver: Conn | null, current: Conn }} FakeState
 *   pending: snapshots sent before their turn’s start. tools and prompts: what waits for Postbox, keyed by key(turn,
 *   id), since a prompt’s or a tool call’s identity is both. answers and replies: those that reached a waiting prompt
 *   or a queued tool. driver: the connection that said hello and drives the daemon.
 */

/** @param {string} turn @param {string} id */
export const key = (turn, id) => `${turn}\n${id}`;

/** @param {FakeState} d @param {Conn} c @param {string} type @param {Record<string, unknown>} body */
export function send(d, c, type, body) {
  if (c.closed) return;
  const msg = message('daemon-to-postbox', type, body);
  d.sent.push(msg);
  c.stdout.write(encode(msg));
}

/** @param {FakeState} d @param {Conn} c @param {string} code @param {string} text @param {string} [re] @param {string} [turn] */
export const fail = (d, c, code, text, re, turn) => send(d, c, 'error', { code, message: text, ...(re ? { re } : {}), ...(turn ? { turn } : {}) });

/** @param {FakeState} d @param {Conn} c */
export function close(d, c) {
  if (c.closed) return;
  c.closed = true;
  c.follows.clear();
  if (d.driver === c) d.driver = null;
  d.conns.delete(c);
  c.stdout.end();
}

/** @param {FakeState} d @param {string} turn @param {string} harness @param {string} stdin @param {string[]} outLines */
export function makeTurn(d, turn, harness, stdin, outLines) {
  /** @type {FakeTurn} */
  const t = { turn, harness, stdin, start: null, out: [], in: [], exit: null, interrupted: false, acked: 0, writes: [], snapshot: null, snapshotItems: [] };
  for (const text of outLines) push(t.out, text);
  d.turns.set(turn, t);
  return t;
}

/** @param {Line[]} log */
export const size = (log) => log.at(-1)?.next ?? 0;

/** @param {Line[]} log @param {string} text */
export function push(log, text) {
  const offset = size(log);
  const line = { offset, next: offset + utf8Bytes(text) + 1, text };
  log.push(line);
  return line;
}

/** @param {FakeState} d @param {string} turn @param {string} log */
export const followers = (d, turn, log) => [...d.conns].filter((c) => c.follows.has(`${turn}:${log}`));
/** @param {FakeState} d @param {Conn} c @param {FakeTurn} t @param {string} log @param {Line} l */
export const sendLine = (d, c, t, log, l) =>
  send(d, c, 'line', { turn: t.turn, ...(log === 'in' ? { log } : {}), offset: l.offset, next: l.next, text: l.text });
/** @param {FakeState} d @param {Conn} c @param {FakeTurn} t */
export const sendEnded = (d, c, t) => send(d, c, 'ended', { turn: t.turn, exit: t.exit, size: size(t.out) });

/** @param {FakeState} d @param {FakeTurn} t @param {{ code: number | null, signal: string | null }} how */
export function finish(d, t, how) {
  if (t.exit || t.interrupted) return;
  t.exit = { code: how.code, signal: how.signal, at: d.now() };
  for (const c of followers(d, t.turn, 'out')) {
    sendEnded(d, c, t);
    c.follows.delete(`${t.turn}:out`);
  }
}

/** @param {FakeTurn} t */
const turnState = (t) => (t.exit ? 'ended' : t.interrupted ? 'interrupted' : 'running');

/**
 * What the daemon does with each of Postbox’s messages, once hello has passed.
 * @type {Record<string, (d: FakeState, c: Conn, m: any) => any>}
 */
export const HANDLERS = {
  start(d, c, m) {
    if (!d.harnesses.includes(m.harness)) return fail(d, c, 'no-harness', `${m.harness} isn’t installed on this host.`, 'start', m.turn);
    if (d.turns.has(m.turn)) return fail(d, c, 'turn-exists', `There’s already a turn ${m.turn} on this host.`, 'start', m.turn);
    const t = makeTurn(d, m.turn, m.harness, m.stdin, d.lines);
    t.start = m;
    t.snapshot = d.pending.get(m.turn) ?? null;
    d.pending.delete(m.turn);
    send(d, c, 'started', { turn: m.turn });
    if (d.autoEnd) finish(d, t, d.exit);
  },
  snapshot(d, _c, m) {
    const t = d.turns.get(m.turn);
    if (t) t.snapshot = m;
    else d.pending.set(m.turn, m);
  },
  'snapshot-items'(d, c, m) {
    const t = d.turns.get(m.turn);
    if (!t) return fail(d, c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'snapshot-items', m.turn);
    t.snapshotItems.push(m);
  },
  read(d, c, m) {
    const t = d.turns.get(m.turn);
    if (!t) return fail(d, c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'read', m.turn);
    const log = m.log ?? 'out';
    const all = log === 'in' ? t.in : t.out;
    if (m.from !== size(all) && !all.some((l) => l.offset === m.from))
      return fail(d, c, 'bad-offset', `${m.from} isn’t the start of a line in ${m.turn}’s ${log} log.`, 'read', m.turn);
    for (const l of all) if (l.offset >= m.from) sendLine(d, c, t, log, l);
    // As the real daemon does: once the first pass has sent what the log had (daemon.mjs’s follow).
    if (d.holdCaughtUp.includes(log)) c.held = [...(c.held ?? []), { turn: t.turn, log }];
    else send(d, c, 'caught-up', { turn: t.turn, log, size: size(all) });
    if (log === 'out' && (t.exit || t.interrupted)) sendEnded(d, c, t);
    else c.follows.set(`${t.turn}:${log}`, true);
  },
  write(d, c, m) {
    const t = d.turns.get(m.turn);
    if (!t) return fail(d, c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'write', m.turn);
    if (t.stdin !== 'held') return fail(d, c, 'not-held', `Turn ${m.turn}’s stdin isn’t held, so it takes no lines.`, 'write', m.turn);
    if (t.exit || t.interrupted) return fail(d, c, 'turn-ended', `Turn ${m.turn} has ended.`, 'write', m.turn);
    t.writes.push(m.line);
    const l = push(t.in, m.line);
    send(d, c, 'written', { turn: t.turn, upTo: l.next });
    for (const f of followers(d, t.turn, 'in')) sendLine(d, f, t, 'in', l);
  },
  answer(d, c, m) {
    if (!d.prompts.delete(key(m.turn, m.prompt)))
      return fail(d, c, 'no-prompt', `Prompt ${m.prompt} of turn ${m.turn} isn’t waiting any more.`, 'answer', m.turn);
    d.answers.push({ turn: m.turn, id: m.prompt, result: m.result });
  },
  reply(d, c, m) {
    if (!d.tools.delete(key(m.turn, m.id))) return fail(d, c, 'no-tool', `Tool call ${m.id} of turn ${m.turn} isn’t queued.`, 'reply', m.turn);
    d.replies.push({ turn: m.turn, id: m.id, ok: m.ok, text: m.text });
  },
  stop(d, c, m) {
    const t = d.turns.get(m.turn);
    if (!t) return fail(d, c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'stop', m.turn);
    d.stops.push(m.turn);
    const reading = c.follows.has(`${m.turn}:out`);
    finish(d, t, d.stopExit);
    // As the real daemon’s quiet follower: a connection that isn’t reading the turn hears its `ended` on its own.
    if (!reading) sendEnded(d, c, t);
  },
  ack(d, c, m) {
    const t = d.turns.get(m.turn);
    if (!t) return fail(d, c, 'no-turn', `There’s no turn ${m.turn} on this host.`, 'ack', m.turn);
    if (m.upTo > size(t.out)) return fail(d, c, 'bad-offset', `${m.upTo} is past the end of ${m.turn}’s log.`, 'ack', m.turn);
    t.acked = Math.max(t.acked, m.upTo);
  },
  // As the real daemon does: the signInCheck this connection’s hello sent, or no-check.
  async check(d, c) {
    const argv = c.settings?.signInCheck;
    if (!argv) return fail(d, c, 'no-check', 'This host has no signInCheck in its settings.', 'check');
    d.checks.push(argv);
    const { code } = await d.check(argv);
    send(d, c, 'checked', { ok: code === 0, code, at: d.now() });
  },
  remove(d, c) {
    d.removes++;
    if (d.removing === 'silent') return;
    if (d.removing === 'drop') return close(d, c);
    // cleanup.mjs’s rootProblem, word for word but the path.
    if (d.removing === 'refuse')
      return fail(d, c, 'internal', '/home/user/.postbox-remote isn’t a folder (it’s a link or a file), so Postbox won’t delete anything in it.', 'remove');
    for (const t of d.turns.values()) finish(d, t, d.stopExit);
    d.turns.clear();
    send(d, c, 'removed', {});
    close(d, c);
  },
};

/** @param {FakeState} d @param {Conn} c @param {any} m */
export function hello(d, c, m) {
  if (m.version !== PROTOCOL_VERSION)
    return fail(
      d,
      c,
      'version',
      `This host’s daemon speaks protocol ${PROTOCOL_VERSION}, and Postbox sent ${m.version}. Install this Postbox’s version on the host.`,
      'hello',
    );
  if (m.token !== d.token) return fail(d, c, 'bad-token', 'The token doesn’t match the host’s. Reinstall Postbox on the host.', 'hello');
  if (d.driver && d.driver !== c) {
    if (!m.takeover) return fail(d, c, 'busy', 'Another Postbox is using this host. Take over to use it from here.', 'hello');
    fail(d, d.driver, 'taken-over', 'Another Postbox took over this host.');
    close(d, d.driver);
  }
  d.driver = c;
  c.ready = true;
  c.settings = m.settings ?? {};
  send(d, c, 'welcome', welcome(d));
  for (const q of d.tools.values()) send(d, c, 'tool', { turn: q.turn, id: q.id, name: q.name, args: q.args });
  for (const p of d.prompts.values()) send(d, c, 'prompt', { id: p.id, turn: p.turn, request: p.request });
}

/** The welcome’s body. @param {FakeState} d */
function welcome(d) {
  const { home, harnesses } = d;
  return {
    version: PROTOCOL_VERSION,
    home,
    node: { path: '/usr/bin/node', version: 'v22.12.0' },
    harnesses: HARNESSES.map((name) =>
      harnesses.includes(name)
        ? { name, path: `${home}/.local/bin/${name === 'claude-code' ? 'claude' : name}`, version: name === 'claude-code' ? '2.1.296' : null, looked: [] }
        : { name, path: null, version: null, looked: [`${home}/.local/bin`, '/usr/local/bin'] },
    ),
    problems: d.problems,
    turns: [...d.turns.values()].map((t) => ({ turn: t.turn, harness: t.harness, state: turnState(t), size: size(t.out), exit: t.exit })),
  };
}
