// What the runtime still has going as Postbox closes: the timers it started, cleared. A timer that outlived close()
// fired on a closed store: a lint turn due after a turn delivered there, and logged “@x’s turn waits: Postbox can’t save
// changes right now” into whatever the process ran next (found by the browser specs’ server-log guard,
// tests/server-log.mjs). The archive pass, the hosts, the mirrors and the shell commands have stops of their own, which
// close() calls.

import { stopSummaryTimers } from './thread-summary.mjs';

/**
 * Clears scheduled wakes, lint turns waiting to settle, stopped turns’ watchdogs, permission cards’ waits, the kept
 * jobs’ poll and summaries waiting to be written. close() calls it before the turns stop and again after, since a
 * turn that ends as it stops can start one.
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
