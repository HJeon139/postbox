// Stop (daemon.mjs’s header, #120): SIGINT to a turn’s process group, then SIGKILL to it and to its tool shells’
// groups after the grace period, only while runner.json still names a live runner.

import { promises as fsp } from 'node:fs';
import { FILE_MODE, TURN_FILES, validateRunnerRecord } from '../../../shared/remote-protocol.mjs';
import { readExit, readJson } from './daemon-files.mjs';
import { follow } from './daemon-follow.mjs';
import { needTurn } from './daemon-reply.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/**
 * SIGINT to the turn’s process group, then SIGKILL after the grace period, and only while runner.json still names a
 * live process (PID, boot ID and start time). If it doesn’t, the turn is interrupted, and nothing is signaled. The
 * connection hears `ended` on its read of the turn, or on its own if it isn’t reading it.
 *
 * Claude Code’s tool shells each lead a session of their own, outside the turn’s group, and outlive a SIGKILL to it
 * (proc.mjs, “A turn’s tool shells”). So their groups are recorded at SIGINT and again at SIGKILL, while the CLI that
 * started them is still their parent, and the SIGKILL goes to each one still there, then to the turn’s group.
 * @param {Daemon} d @param {Conn} c @param {any} m
 */
export async function stop(d, c, m) {
  // Marked first, so a start that comes from now on, on any connection, is refused. One already under way is waited
  // for: it starts nothing if its runner hadn’t launched yet, and its runner is stopped below if it had.
  d.stoppedFirst.add(m.turn);
  while (d.starting.has(m.turn)) await d.starting.get(m.turn);
  if (!(await needTurn(d, c, m.turn, 'stop'))) return;
  // It’s here: a start for it again is turn-exists, as ever.
  d.stoppedFirst.delete(m.turn);
  await stopTurn(d, m.turn);
  if (!c.follows.has(`${m.turn}:out`)) follow(d, c, m.turn, 'out', 0, true);
}
/**
 * Stop without a connection to answer (the cap and `remove` use it too): whether a runner was signaled.
 * @param {Daemon} d @param {string} turn @returns {Promise<boolean>}
 */
export async function stopTurn(d, turn) {
  // First, so a shim call made from here on is refused, as on the laptop (#126).
  await d.brk.stopping?.(turn);
  if (await readExit(d, turn)) return false;
  const rec = validateRunnerRecord(await readJson(d.p.turn(turn, TURN_FILES.runner)));
  if (!rec.ok || !(await d.proc.sameProcess(rec.msg))) {
    d.log(
      `Stop for turn ${turn}: ${rec.ok ? `process ${rec.msg.pid} isn’t its runner any more` : 'no valid runner.json'}, so it’s interrupted; nothing was signaled.`,
    );
    d.dead.add(turn);
    pokeTurn(d, turn);
    return false;
  }
  const pid = rec.msg.pid;
  recordShells(d, turn, pid);
  signal(d, pid, 'SIGINT', turn);
  if (!d.killTimers.has(turn))
    d.killTimers.set(
      turn,
      d.timers.setTimeout(() => killAfterGrace(d, turn, rec.msg), d.stopGraceMs),
    );
  return true;
}

/**
 * The SIGKILL, once Stop’s grace period is over.
 * @param {Daemon} d @param {string} turn @param {import('../../../shared/remote-protocol.mjs').RunnerRecord} runner
 */
async function killAfterGrace(d, turn, runner) {
  const pid = runner.pid;
  d.killTimers.delete(turn);
  // The harness may have ended on SIGINT and left a shell running, so the recorded shell groups still
  // there are killed either way, as the laptop’s stopTurn does. liveGroups matches a group only by a member
  // with the start time it was recorded with, so a reused PID is never hit. Only the turn’s own group waits on
  // runner.json still naming a live runner.
  const ended = (await readExit(d, turn)) || !(await d.proc.sameProcess(runner));
  if (!ended) recordShells(d, turn, pid);
  const found = [...(d.shells.get(turn)?.values() ?? [])];
  d.shells.delete(turn);
  for (const g of await d.proc.liveGroups(found)) signal(d, g.pgid, 'SIGKILL', turn, 'tool shell group');
  if (ended) return;
  signal(d, pid, 'SIGKILL', turn);
  // The runner went with its group, so nobody else will say how the harness ended.
  try {
    await fsp.writeFile(d.p.turn(turn, TURN_FILES.exit), JSON.stringify({ code: null, signal: 'SIGKILL', at: d.now() }), { mode: FILE_MODE, flag: 'wx' });
  } catch {}
  pokeTurn(d, turn);
}

/**
 * Adds the tool shells’ groups under a turn’s group, as they are now, to what Stop has recorded for it (a group seen
 * both times keeps the members it had each time).
 * @param {Daemon} d @param {string} turn @param {number} pgid
 */
function recordShells(d, turn, pgid) {
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
const signal = (d, pgid, sig, turn, what = 'group') => {
  try {
    d.kill(-pgid, sig);
    d.log(`Sent ${sig} to turn ${turn}’s ${what} ${pgid}.`);
  } catch (e) {
    if (e.code !== 'ESRCH') d.log(`Couldn’t send ${sig} to turn ${turn}’s ${what} ${pgid}: ${e.message}`);
  }
};
/** Wakes every follower of a turn, on every connection. @param {Daemon} d @param {string} turn */
const pokeTurn = (d, turn) => {
  for (const c of d.conns) for (const [k, f] of c.follows) if (k.startsWith(`${turn}:`)) f.poke();
};
