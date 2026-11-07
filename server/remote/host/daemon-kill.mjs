// Signaling a turn’s processes (daemon.mjs’s header, #120): its tool shells’ groups as they’re recorded for it, and a
// signal to a process group, said in the log. Stop (daemon-stop.mjs) uses them.

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon */

/**
 * Adds the tool shells’ groups under a turn’s group, as they are now, to what Stop has recorded for it (a group seen
 * both times keeps the members it had each time).
 * @param {Daemon} d @param {string} turn @param {number} pgid
 */
export function recordShells(d, turn, pgid) {
  const seen = d.proc.toolGroups(pgid);
  if (seen === null) d.log(`Couldn’t list this host’s processes, so Stop for turn ${turn} reaches only its own group, not its tool shells.`);
  const mine = d.shells.get(turn) ?? new Map();
  for (const g of seen ?? []) {
    const had = mine.get(g.pgid);
    mine.set(g.pgid, had ? { pgid: g.pgid, members: [...had.members, ...g.members] } : g);
  }
  d.shells.set(turn, mine);
}
/** @param {Daemon} d @param {number} pgid @param {NodeJS.Signals} sig @param {string} turn */
export const signal = (d, pgid, sig, turn, what = 'group') => {
  try {
    d.kill(-pgid, sig);
    d.log(`Sent ${sig} to turn ${turn}’s ${what} ${pgid}.`);
  } catch (e) {
    if (e.code !== 'ESRCH') d.log(`Couldn’t send ${sig} to turn ${turn}’s ${what} ${pgid}: ${e.message}`);
  }
};
