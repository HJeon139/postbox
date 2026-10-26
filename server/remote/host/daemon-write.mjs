// Postbox’s `write` (daemon.mjs’s header, #120): one line for a turn’s held stdin, through its runner, which logs it
// to in.jsonl before the harness’s pipe.

import { TURN_FILES, validateStartRecord } from '../../../shared/remote-protocol.mjs';
import { readExit, readJson, readToken } from './daemon-files.mjs';
import { fail, needTurn, send } from './daemon-reply.mjs';
import { sendStdin } from './runner-client.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/** @param {Daemon} d @param {Conn} c @param {any} m */
export async function write(d, c, m) {
  if (!(await needTurn(d, c, m.turn, 'write'))) return;
  const start = validateStartRecord(await readJson(d.p.turn(m.turn, TURN_FILES.start)));
  if (!start.ok || start.msg.stdin !== 'held') return fail(c, 'not-held', `Turn ${m.turn}’s stdin isn’t held, so it takes no lines.`, 'write', m.turn);
  if (await readExit(d, m.turn)) return fail(c, 'turn-ended', `Turn ${m.turn} has ended.`, 'write', m.turn);
  // A Codex answer to a request the broker already declined would be a second answer to it.
  const check = d.brk.checkWrite?.(m.turn, m.line) ?? { done: () => {} };
  if ('refused' in check) return fail(c, 'no-prompt', check.refused, 'write', m.turn);
  let upTo;
  try {
    upTo = await writeHeld(d, m.turn, m.line);
  } catch (e) {
    check.done(false);
    return fail(c, e.code === 'internal' ? 'internal' : 'turn-ended', e.message, 'write', m.turn);
  }
  check.done(true);
  send(c, 'written', { turn: m.turn, upTo });
}

/** One line for a turn’s held stdin, through its runner; resolves with in.jsonl’s size after it. @param {Daemon} d @param {string} turn @param {string} line */
export async function writeHeld(d, turn, line) {
  const token = readToken(d);
  if (!token) throw Object.assign(new Error(`Couldn’t read the host’s token at ${d.p.token}.`), { code: 'internal' });
  try {
    return await d.writeRunner({ socketPath: d.p.turn(turn, TURN_FILES.socket), turn, line, token });
  } catch (e) {
    throw new Error(`Turn ${turn}’s runner didn’t take the line: ${e.message}`);
  }
}

// ── The runner’s socket ──

/**
 * Sends one line for a held stdin to a turn’s runner with runner.mjs’s sendStdin: `who` with the token, which the
 * runner answers with `iam` for its turn, then `stdin`, which it answers with `written`.
 * @type {import('./daemon-constants.mjs').WriteRunner}
 */
export function defaultWriteRunner({ socketPath, turn, line, token }) {
  return sendStdin(socketPath, line, { token, turn });
}
