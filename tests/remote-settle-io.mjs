// Helpers the settle-path specs share (tests/remote-settle-races.test.mjs, tests/remote-settle-resend.test.mjs): a
// file layer for the broker's io seam that holds one matching call until the test lets it go, and the turn's journal.

import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import { TURN_FILES } from '../shared/remote-protocol.mjs';

/** The turn's journal records; none when the file is not there yet, so the assertion reads as behavior. */
export const journal = (h, turn) => {
  const file = h.p.turn(turn, TURN_FILES.tools);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

/** The held call reached, or a failure naming it, after 2 s: a red run fails here instead of waiting forever. */
export const reached = (hold) =>
  Promise.race([hold.entered, new Promise((_, rej) => setTimeout(() => rej(new Error('the held file call was never reached')), 2000))]);

/** A file layer whose first matching call is held until released, then fails if `reject`; `entered` resolves when it is reached. */
export const holdingIo = (match, { reject = false } = {}) => {
  let release = () => {};
  let arrive = () => {};
  const gate = new Promise((r) => (release = r));
  const entered = new Promise((r) => (arrive = r));
  let held = false;
  const hold = async (call) => {
    if (!held && match(call)) {
      held = true;
      arrive();
      await gate;
      // The held call fails once let go, as a disk that errors does.
      if (reject) throw Object.assign(new Error('EIO: the journal write failed'), { code: 'EIO' });
    }
  };
  return {
    io: {
      readFile: async (path, enc) => {
        await hold({ kind: 'readFile', path });
        return fsp.readFile(path, enc);
      },
      appendFile: async (path, line, opt) => {
        await hold({ kind: 'appendFile', path, line });
        return fsp.appendFile(path, line, opt);
      },
      stat: (path) => fsp.stat(path),
    },
    entered,
    release,
  };
};
