// How the daemon answers Postbox (daemon.mjs’s header, #120): a message or an error on one connection, or to the
// driving Postbox, whichever connection that is now.

import { encode, message, REMOTE_LIMITS, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { exists } from './daemon-files.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/** @param {Conn} c @param {string} type @param {Record<string, unknown>} body @returns {Promise<void> | undefined} */
export function send(c, type, body) {
  if (c.closed) return;
  const ok = c.output.write(encode(message('daemon-to-postbox', type, body)));
  if (!ok && c.output.once) return new Promise((resolve) => c.output.once?.('drain', () => resolve()));
}
/** @param {Conn} c @param {string} code @param {string} text @param {string} [re] @param {string} [turn] @returns {undefined} */
export function fail(c, code, text, re, turn) {
  send(c, 'error', { code, message: text.slice(0, REMOTE_LIMITS.messageChars), ...(re ? { re } : {}), ...(turn ? { turn } : {}) });
}

/** The turn’s folder, or an error to the connection. @param {Daemon} d @param {Conn} c @param {string} turn @param {string} re */
export async function needTurn(d, c, turn, re) {
  if (await exists(d.p.turn(turn, TURN_FILES.start))) return true;
  fail(c, 'no-turn', `There’s no turn ${turn} on this host.`, re, turn);
  return false;
}

/** Whether a Postbox that said hello drives the daemon. @param {Daemon} d */
export const attached = (d) => Boolean(d.driver && !d.driver.closed && d.driver.ready);
/** Sends a message to the driving Postbox, if one is attached. Returns whether it went. @param {Daemon} d @param {string} type @param {Record<string, unknown>} body */
export const toPostbox = (d, type, body) => {
  if (!d.driver || !attached(d)) return false;
  send(d.driver, type, body);
  return true;
};
