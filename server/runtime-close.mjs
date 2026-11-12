// What the runtime still has going as Postbox closes: the timers it started, cleared, and the work ledger’s records of
// the turns that just stopped, waited for. A timer that outlived close() fired on a closed store: a lint turn due after
// a turn delivered there, and logged “@x’s turn waits: Postbox can’t save changes right now” into whatever the process
// ran next; and a ledger record that landed after the store closed was dropped (both found by the browser specs’
// server-log guard, tests/server-log.mjs). The archive pass, the hosts, the mirrors and the shell commands have stops
// of their own, which close() calls.

import { stopSummaryTimers } from './thread-summary.mjs';

/** How long close() waits for the ledger’s records, so a file read that never answers can’t hold the shutdown. */
const LEDGER_GRACE_MS = 4000;

/**
 * Clears scheduled wakes, lint turns waiting to settle, stopped turns’ watchdogs, permission cards’ waits, the kept
 * jobs’ poll and summaries waiting to be written. close() calls it before the turns stop, again after, and once more
 * after the hosts stop, since a turn that ends as it stops, or as its host’s link closes, can start one.
 * @param {import('./runtime.mjs').Runtime} rt
 */
export function stopTimers(rt) {
  for (const t of rt.timers.values()) clearTimeout(t);
  for (const lint of rt.lints.values()) {
    clearTimeout(lint.timer);
    lint.timer = null;
  }
  for (const t of rt.watchdogs) clearTimeout(t);
  rt.watchdogs.clear();
  for (const w of rt.permissionWaits.values()) clearTimeout(w.timer);
  if (rt.keptPoll) clearInterval(rt.keptPoll);
  rt.keptPoll = null;
  stopSummaryTimers(rt);
}

/**
 * Waits, up to LEDGER_GRACE_MS (config.ledgerGraceMs in a test), for the work ledger’s records in flight: a stopped turn’s end reads each file it changed
 * before it patches the turn’s entry, and a store closed under it drops the patch.
 * @param {import('./runtime.mjs').Runtime} rt
 */
export async function settleLedger(rt) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const late = new Promise((r) => {
    timer = setTimeout(r, rt.config.ledgerGraceMs ?? LEDGER_GRACE_MS);
  });
  await Promise.race([rt.ledger.idle(), late]);
  clearTimeout(timer);
}
