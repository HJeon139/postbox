// Signaling a turn’s processes (daemon.mjs’s header, #120): its tool shells’ groups as they’re recorded for it, a
// signal to a process group, said in the log, and the kill of a runner hung past the silence ceiling (#872). Stop
// (daemon-stop.mjs) and the ceiling (daemon-running.mjs) share them, so a turn has one kill path.

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('../../../shared/remote-protocol.mjs').RunnerRecord} RunnerRecord */

/**
 * A runner silent past the ceiling (daemon-running.mjs): SIGKILL to its tool shells’ groups and to its own, as Stop’s
 * after its grace period, with no SIGINT first, since a runner that doesn’t answer won’t hear one. Only while
 * runner.json’s process is still its runner, and never during Stop’s grace period, whose own SIGKILL ends the turn.
 * It writes no exit.json: the turn ends as interrupted once its process is gone, and the laptop resumes it alone.
 * @param {Daemon} d @param {string} turn @param {RunnerRecord} runner
 */
export async function endHung(d, turn, runner) {
  if (d.killTimers.has(turn)) {
    d.log(`Turn ${turn} is being stopped, so its runner (process ${runner.pid}) is left to Stop’s SIGKILL.`);
    return;
  }
  if (!(await d.proc.sameProcess(runner))) {
    d.log(`Turn ${turn}’s process ${runner.pid} isn’t its runner any more, so nothing was signaled.`);
    return;
  }
  recordShells(d, turn, runner.pid);
  await killShells(d, turn);
  signal(d, runner.pid, 'SIGKILL', turn);
}

/**
 * SIGKILL to each recorded tool shell group still there, and the record forgotten. liveGroups matches a group only by
 * a member with the start time it was recorded with, so a reused PID is never hit. @param {Daemon} d @param {string} turn
 */
export async function killShells(d, turn) {
  const found = [...(d.shells.get(turn)?.values() ?? [])];
  d.shells.delete(turn);
  for (const g of await d.proc.liveGroups(found)) signal(d, g.pgid, 'SIGKILL', turn, 'tool shell group');
}

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
