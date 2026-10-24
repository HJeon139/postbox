// What a remote turn’s child sends the daemon (process.mjs, whose header is the design): start, read, ack, the held
// stdin’s lines one at a time, and whatever didn’t reach the daemon, at each welcome. Each takes the child first.

import { MESSAGE_FILE, message, utf8Bytes } from '../../shared/remote-protocol.mjs';

/** @typedef {import('./process.mjs').RemoteProcess} RemoteProcess */

/** @param {RemoteProcess} _p @param {string} type @param {Record<string, unknown>} body */
export function build(_p, type, body) {
  return message('postbox-to-daemon', type, body);
}

/** @param {RemoteProcess} p @param {string} type @param {Record<string, unknown>} body */
export function send(p, type, body) {
  return p.conn.send(p.build(type, body)) === true;
}

/** start’s files: the caller’s, and for a file stdin the message. @param {string | null} text @param {RemoteProcess} p */
export function startFiles(p, text) {
  const b = /** @type {NonNullable<typeof p.startBody>} */ (p.startBody);
  return { ...b, files: b.stdin === 'file' ? [...b.files, { name: MESSAGE_FILE, text: text ?? '' }] : b.files };
}

/** @param {RemoteProcess} p @param {Record<string, unknown>} body */
export function sendStart(p, body) {
  if (p.ended || p.killed || !p.startBody) return;
  let msg;
  try {
    msg = p.build('start', body);
  } catch (e) {
    return p.fail(e);
  }
  p.startBody = /** @type {any} */ (body);
  p.startSent = true;
  // Unsent, it goes at the next welcome, as one that may have been lost in a drop does.
  if (p.conn.send(msg) === true) p.startWritten = true;
  p.pump();
}

/** @param {RemoteProcess} p */
export function read(p) {
  if (p.ended) return;
  // in.jsonl first: it’s small, and its reader then starts before out.jsonl’s (a rebuild wants it all early).
  if (p.kind === 'held') {
    const c = p.checking;
    if (c) p.send('read', { turn: p.turn, from: c.end, log: 'in' });
    p.send('read', { turn: p.turn, from: c ? Math.min(c.base, p.inNext) : p.inNext, log: 'in' });
  }
  // Unsent, it goes at the next welcome.
  p.send('read', { turn: p.turn, from: p.next });
}

/** @param {RemoteProcess} p */
export function ack(p) {
  if (p.ackTimer) clearTimeout(p.ackTimer);
  p.ackTimer = null;
  p.unacked = 0;
  if (p.next > p.acked && p.send('ack', { turn: p.turn, upTo: p.next })) p.acked = p.next;
}

/** The next held-stdin line, once the one before it is written. @param {RemoteProcess} p */
export function pump(p) {
  while (!p.ended && p.startSent && !p.inFlight && p.queue.length) {
    const line = /** @type {string} */ (p.queue.shift());
    let msg;
    try {
      msg = p.build('write', { turn: p.turn, line });
    } catch (e) {
      p.note(`A line for the agent’s stdin couldn’t be sent, so it was dropped: ${e.message}`);
      continue;
    }
    p.inFlight = { line, sent: p.conn.send(msg) === true, base: Math.max(p.inUpTo, p.inNext) };
  }
}

/** Whatever didn’t reach the daemon, at a welcome. @param {RemoteProcess} p */
export function resume(p) {
  if (p.ended) return;
  if (p.killed && !p.started) {
    // Killed with its start unconfirmed: that start may be on the host, and a stop that went before it, or was lost,
    // may have found no turn there. So it’s stopped again, and its start never goes again: a turn mustn’t start
    // after the person asked to stop it.
    p.stopPending = !p.send('stop', { turn: p.turn });
  } else if (p.stopPending) p.stopPending = !p.send('stop', { turn: p.turn });
  if (!p.killed && p.startSent && !p.started && p.startBody) {
    // It may have reached the daemon before the drop: a turn-exists answer then means it did.
    p.startResent = true;
    if (p.conn.send(p.build('start', p.startBody)) === true) p.startWritten = true;
  }
  if (p.inFlight?.sent) {
    // Kept in flight, so nothing passes it, until in.jsonl says whether it arrived (the header). read() asks.
    const { line, base } = p.inFlight;
    p.checking = { line, base, end: base + utf8Bytes(line) + 1 };
  } else if (p.inFlight) {
    p.queue.unshift(p.inFlight.line);
    p.inFlight = null;
  }
  p.pump();
  if (p.started) {
    p.read();
    if (p.next > p.acked) p.ack();
  }
}
