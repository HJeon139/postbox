// The daemon’s connections (daemon.mjs’s header, #120): a Postbox channel over a pair of streams or the daemon’s
// socket, its messages handled in order, and a shim’s connection, told apart by its first line.

import { createLineReader, encode, parseLine, validateMessage } from '../../../shared/remote-protocol.mjs';
import { check } from './daemon-check.mjs';
import { hello } from './daemon-hello.mjs';
import { ack, read } from './daemon-read.mjs';
import { remove } from './daemon-remove.mjs';
import { fail, send } from './daemon-reply.mjs';
import { checkIdle } from './daemon-scan.mjs';
import { start } from './daemon-start.mjs';
import { stop } from './daemon-stop.mjs';
import { write } from './daemon-write.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */
/** @typedef {import('./daemon-constants.mjs').Output} Output */

/**
 * A Postbox channel: lines from it go to line(), and send() writes to output. Returns the line handlers.
 * @param {Daemon} d @param {Output} output @param {() => void} [end]  closes the transport (a socket’s end); output.end() by default
 */
function openConn(d, output, end = () => output.end()) {
  /** @type {Conn} */
  const c = {
    id: ++d.ids,
    output,
    ready: false,
    closed: false,
    follows: new Map(),
    queue: Promise.resolve(),
    close() {
      if (c.closed) return;
      c.closed = true;
      for (const f of c.follows.values()) f.stop();
      c.follows.clear();
      if (d.driver === c) d.driver = null;
      d.conns.delete(c);
      d.lastActive = d.now();
      try {
        end();
      } catch {}
      checkIdle(d);
    },
  };
  d.conns.add(c);
  checkIdle(d);
  return {
    conn: c,
    /** @param {string} text  one line, without its \n */
    line: (text) => connLine(d, c, text),
    /** @param {{ message: string }} e */
    error(e) {
      if (!c.closed) fail(c, 'bad-message', e.message);
    },
    close: () => c.close(),
  };
}

/** One line from a Postbox channel. @param {Daemon} d @param {Conn} c @param {string} text */
function connLine(d, c, text) {
  if (c.closed) return;
  const r = parseLine('postbox-to-daemon', text);
  if (!r.ok) return fail(c, 'bad-message', r.error);
  // Handled in order: Postbox may send read right after start.
  c.queue = c.queue.then(() =>
    c.closed
      ? undefined
      : dispatch(d, c, r.msg).catch((e) => {
          d.log(`A ${r.msg.type} failed: ${e.stack ?? e.message}`);
          fail(c, 'internal', `The daemon couldn’t handle ${r.msg.type}: ${e.message}`, r.msg.type, r.msg.turn);
        }),
  );
}

/** Each message after hello, by type. @type {Record<string, (d: Daemon, c: Conn, m: any) => Promise<void> | void>} */
const handlers = {
  start: (d, c, m) => start(d, c, m),
  read: (d, c, m) => read(d, c, m),
  write: (d, c, m) => write(d, c, m),
  stop: (d, c, m) => stop(d, c, m),
  ack: (d, c, m) => ack(d, c, m),
  remove: (d, c) => remove(d, c),
  check: (d, c) => check(d, c),
};

/** @param {Daemon} d @param {Conn} c @param {any} m */
async function dispatch(d, c, m) {
  if (m.type === 'hello') return hello(d, c, m);
  if (!c.ready) return fail(c, 'not-ready', 'Say hello with the host’s token first.', m.type, m.turn);
  if (d.removing) return fail(c, 'internal', 'Postbox is being removed from this host.', m.type, m.turn);
  if (Object.hasOwn(handlers, m.type)) return handlers[m.type](d, c, m);
  // A refused answer or reply names its prompt or call, so Postbox knows which card or call it was (#120).
  const of = typeof m.prompt === 'string' ? m.prompt : typeof m.id === 'string' ? m.id : undefined;
  const reply = { send: (type, body) => send(c, type, body), fail: (code, text) => fail(c, code, text, m.type, m.turn, of) };
  if (d.brk.message && (await d.brk.message(m, reply))) return;
  const code = { answer: 'no-prompt', reply: 'no-tool' }[m.type] ?? 'internal';
  fail(c, code, `This daemon doesn’t handle ${m.type} yet.`, m.type, m.turn);
}

/**
 * Splits a channel’s bytes into lines for a handler.
 * @param {(text: string) => void} onLine @param {(e: { message: string }) => void} onError
 */
const lineReader = (onLine, onError) => createLineReader({ onLine, onError });

/**
 * A Postbox channel over a pair of streams, such as an ssh child’s, or PassThroughs in a test.
 * @param {Daemon} d @param {{ input: import('node:stream').Readable, output: Output & { end: () => void } }} io
 */
export function connectStreams(d, { input, output }) {
  const h = openConn(d, output);
  const reader = lineReader(h.line, h.error);
  input.on('data', (b) => reader.push(b));
  input.on('end', () => {
    reader.end();
    h.close();
  });
  input.on('error', () => h.close());
  return h.conn;
}

/**
 * A connection to the daemon’s socket: a relayed Postbox, or a turn’s shim, by its first line.
 * @param {Daemon} d @param {import('node:net').Socket} socket
 */
export function acceptSocket(d, socket) {
  /** @type {{ line: (text: string) => void, error?: (e: { message: string }) => void, close: () => void } | null} */
  let h = null;
  const first = (text) => {
    const opened = firstLine(d, socket, text);
    h = opened?.h ?? null;
    if (opened?.postbox) h?.line(text);
  };
  const reader = lineReader(
    (text) => (h ? h.line(text) : first(text)),
    (e) => (h?.error ? h.error(e) : socket.destroy()),
  );
  socket.on('data', (b) => reader.push(b));
  socket.on('end', () => {
    reader.end();
    h?.close();
    socket.end();
  });
  socket.on('error', (e) => {
    d.log(`A socket connection failed: ${e.message}`);
    h?.close();
  });
  socket.on('close', () => h?.close());
}

/**
 * A socket connection’s first line: a shim’s hello (it has `turn`, not `version`) goes to the shim seam; anything else
 * opens a Postbox channel, which then handles the line (`postbox`). Returns the connection’s line handlers, or null
 * when it was refused.
 * @param {Daemon} d @param {import('node:net').Socket} socket @param {string} text
 */
function firstLine(d, socket, text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {}
  if (v && typeof v === 'object' && v.type === 'hello' && Object.hasOwn(v, 'turn') && !Object.hasOwn(v, 'version')) {
    if (!d.shimSeam) {
      const r = validateMessage('daemon-to-shim', { type: 'error', code: 'internal', message: 'This daemon doesn’t serve the shim yet.' });
      if (r.ok) socket.end(encode(r.msg));
      return null;
    }
    return { h: d.shimSeam({ first: text, write: (s) => socket.write(s), end: () => socket.end() }), postbox: false };
  }
  return { h: openConn(d, socket, () => socket.end()), postbox: true };
}
