// Postbox’s `read` and `ack` (daemon.mjs’s header, #120): a log from any offset at the start of a line, followed
// (daemon-follow.mjs), and how far Postbox has applied out.jsonl, which cleanup.mjs keeps on disk.

import { promises as fsp } from 'node:fs';
import { TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { sizeOf } from './daemon-files.mjs';
import { follow } from './daemon-follow.mjs';
import { fail, needTurn } from './daemon-reply.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/** @param {Daemon} d @param {Conn} c @param {any} m */
export async function read(d, c, m) {
  if (!(await needTurn(d, c, m.turn, 'read'))) return;
  const which = m.log ?? 'out';
  const path = d.p.turn(m.turn, which === 'in' ? TURN_FILES.in : TURN_FILES.out);
  // Logs Postbox acked whole are gone once the turn ended: from 0 or their end, it hears only `ended`.
  const gone = await d.cleanup.deletedSize(m.turn);
  if (gone !== null && (m.from === 0 || m.from === gone)) {
    follow(d, c, m.turn, which, m.from, true, true);
    return;
  }
  if (!(await atLineStart(path, m.from)))
    return fail(c, 'bad-offset', `${m.from} isn’t 0, the start of a line or the end of ${m.turn}’s ${which} log.`, 'read', m.turn);
  follow(d, c, m.turn, which, m.from, false, true);
}

/** Whether an offset is 0, just past a \n, or the file’s size. @param {string} path @param {number} from */
async function atLineStart(path, from) {
  if (from === 0) return true;
  let fh;
  try {
    fh = await fsp.open(path, 'r');
    const { size } = await fh.stat();
    if (from === size) return true;
    if (from > size) return false;
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, from - 1);
    return b[0] === 10;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/** @param {Daemon} d @param {Conn} c @param {any} m */
export async function ack(d, c, m) {
  if (!(await needTurn(d, c, m.turn, 'ack'))) return;
  const size = (await d.cleanup.deletedSize(m.turn)) ?? (await sizeOf(d.p.turn(m.turn, TURN_FILES.out)));
  if (m.upTo > size) return fail(c, 'bad-offset', `${m.upTo} is past the end of ${m.turn}’s log.`, 'ack', m.turn);
  // Kept in the turn folder, so a restarted daemon still knows; an ended turn’s logs may go now (cleanup.mjs).
  d.acked.set(m.turn, await d.cleanup.ack(m.turn, m.upTo));
}
