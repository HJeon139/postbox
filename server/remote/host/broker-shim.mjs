// A shim’s connection to the daemon’s broker (#120): its hello, with the host’s token and its turn, then its calls,
// prompts and the notices that a prompt ended, each handled in the order it came.

import { encode, HOST_DEFAULTS, message, parseLine, REMOTE_LIMITS } from '../../../shared/remote-protocol.mjs';
import { endPrompt, permission } from './broker-prompts.mjs';
import { refusal } from './broker-records.mjs';
import { CANCELED, CANCELED_MSG } from './broker-state.mjs';
import { call } from './broker-tools.mjs';

/**
 * @typedef {import('./broker-state.mjs').Broker} Broker
 * @typedef {import('./broker-state.mjs').ShimConn} ShimConn
 * @typedef {(code: string, text: string) => void} Refuse
 */

/**
 * A shim’s connection to the daemon’s socket. Its first line is its hello.
 * @param {Broker} b @param {{ first: string, write: (s: string) => boolean, end: () => void }} io
 */
export function shimConnection(b, { first, write, end }) {
  /** @type {ShimConn} */
  const c = {
    turn: null,
    closed: false,
    send(type, body) {
      if (c.closed) return;
      try {
        write(encode(message('daemon-to-shim', type, body)));
      } catch (e) {
        b.log(`Couldn’t send ${type} to turn ${c.turn}’s shim: ${e.message}`);
      }
    },
  };
  /** @type {Refuse} */
  const refuse = (code, text) => {
    c.send('error', { code, message: text.slice(0, REMOTE_LIMITS.messageChars) });
    close();
    try {
      end();
    } catch {}
  };
  const close = () => closeShim(b, c);
  /** @type {Promise<void>} */
  let queue = Promise.resolve();
  const line = (text) => {
    queue = queue.then(() => (c.closed ? undefined : handle(b, c, refuse, text))).catch((e) => b.log(`A shim message failed: ${e.stack ?? e.message}`));
  };
  line(first);
  return { line, close };
}

/** @param {Broker} b @param {ShimConn} c */
function closeShim(b, c) {
  if (c.closed) return;
  c.closed = true;
  if (c.turn) b.shims.get(c.turn)?.delete(c);
  if (c.turn && !b.shims.get(c.turn)?.size) b.shims.delete(c.turn);
}

/** One line from a shim. @param {Broker} b @param {ShimConn} c @param {Refuse} refuse @param {string} text */
async function handle(b, c, refuse, text) {
  const r = parseLine('shim-to-daemon', text);
  if (!r.ok) {
    if (!c.turn) return refuse('bad-message', r.error);
    return c.send('error', { code: 'bad-message', message: r.error.slice(0, REMOTE_LIMITS.messageChars) });
  }
  const m = r.msg;
  if (!c.turn) return hello(b, c, refuse, m);
  const turn = c.turn;
  switch (m.type) {
    case 'hello':
      return c.send('error', { code: 'bad-message', message: 'This connection has said hello already.' });
    case 'call':
      return call(b, c, turn, m);
    case 'permission':
      return permission(b, c, turn, m);
    case 'permission-expired':
    case CANCELED_MSG:
      return endPrompt(b, turn, m.id, m.at, m.type === 'permission-expired' ? 'expired' : CANCELED);
  }
}

/** A shim’s first message, which must be its hello. @param {Broker} b @param {ShimConn} c @param {Refuse} refuse @param {any} m */
async function hello(b, c, refuse, m) {
  if (m.type !== 'hello') return refuse('not-ready', 'Say hello with the host’s token and your turn first.');
  if (!b.tokenMatches(m.token)) return refuse('bad-token', 'The token doesn’t match the host’s, in ~/.postbox-remote/token.');
  const no = await refusal(b, m.turn);
  if (no) return refuse(no.code, no.text);
  if (c.closed) return;
  c.turn = m.turn;
  if (!b.shims.has(m.turn)) b.shims.set(m.turn, new Set());
  b.shims.get(m.turn)?.add(c);
  c.send('welcome', { turn: m.turn, permissionWaitMax: b.settings().permissionWaitMax ?? HOST_DEFAULTS.permissionWaitMax });
}
