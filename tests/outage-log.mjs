// The lines Postbox logs on purpose when a test breaks its store with an EIO (#508’s storage design, “When a write
// fails (ST-3)”): the cause, once per failed write, and each turn the closed store stops or holds. The outage tests
// make each failed write through their eio(), which allows these, by their exact text, as many times as they come, so
// any other line those tests log still fails them (tests/server-log.mjs).

import { allowServerLog } from './server-log.mjs';

/** server/store-retry.mjs’s fail(), and Store.emit’s line for an event it couldn’t write, with the test’s EIO. */
const CAUSE =
  /^(An event wasn’t written: )?Postbox can’t write its event log \(EIO\): disk sync refused\. Reads go on; changes aren’t saved until Retry or a restart\.$/;
/** server/store-outage.mjs: a turn the closed store stopped, or one that waits for it to reopen. */
const TURN = /^@[\w-]+’s turn (waits|stopped): Postbox can’t save changes right now\.$/;

/** The EIO a test’s fake disk fails a write with, its lines allowed for the running test. */
export function eio() {
  allowServerLog(CAUSE, { times: Number.POSITIVE_INFINITY });
  allowServerLog(TURN, { times: Number.POSITIVE_INFINITY });
  return Object.assign(new Error('disk sync refused'), { code: 'EIO' });
}
