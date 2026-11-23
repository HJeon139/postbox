// Which processes are a background process’s own (#1614, designs/architecture/background-processes.md, “One lifecycle,
// from registration to cleanup”). Every decision rests on what ps reports, with each process’s start time, so a pid
// that ended and went to another process is never taken for the one Postbox recorded. These are pure functions of a
// snapshot, but for the lister, so the rules are tested against fake process lists.
//
// A command line is what a process says of itself, so it only names a candidate. What binds a launch is its ancestry,
// which the OS reports: the leader’s parent is the foreground launcher, which descends from the backend process of the
// turn that registered it, a process Postbox holds as its own child.

import { execFile } from 'node:child_process';
import { launchOf } from '../shared/process-launch.mjs';

/**
 * A process as ps reports it, with its start time as ps prints it (lstart, to the second).
 * @typedef {{ pid: number, ppid: number, pgid: number, started: string, command: string }} TimedProc
 * A process by its pid and start time: the identity Postbox records, and checks before it signals.
 * @typedef {{ pid: number, started: string }} Ident
 */

/** How far up the parent chain a launch is looked for: deeper than any shell under a CLI. */
const MAX_DEPTH = 64;
/** The most members of a group Postbox records. */
const MAX_MEMBERS = 64;

/** `pid ppid pgid` and lstart, which is five words in the C locale: `Sat Nov 21 21:55:09 2026`. */
const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s(.*)$/;

/** Parses `ps -o pid=,ppid=,pgid=,lstart=,command=` output, in the C locale. @param {string} text @returns {TimedProc[]} */
export function parsePsTimes(text) {
  /** @type {TimedProc[]} */
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = LINE.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: m[4].replace(/\s+/g, ' '), command: m[5].trim() });
  }
  return out;
}

/** A start time as ps printed it, in ms, or NaN. @param {string} started */
export function startMs(started) {
  const [, mon, day, time, year] = String(started).split(' ');
  return Date.parse(`${mon} ${day} ${year} ${time}`);
}

/**
 * Every process on this computer with its start time, from ps (an argument array, no shell), or null if ps can’t run
 * or reports nothing. Null, never []: an empty list would read as every leader gone.
 * @returns {Promise<TimedProc[] | null>}
 */
export function listProcessTimes() {
  const options = { timeout: 2000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } };
  return new Promise((resolve) => {
    try {
      execFile('ps', ['axww', '-o', 'pid=,ppid=,pgid=,lstart=,command='], options, (err, out) => {
        const procs = err ? [] : parsePsTimes(String(out));
        if (!procs.length) psFailed(err);
        resolve(procs.length ? procs : null);
      });
    } catch (e) {
      psFailed(e);
      resolve(null);
    }
  });
}
let saidPs = false;
/** Says once why background processes can’t be watched: every decision waits for a list it can trust. */
const psFailed = (/** @type {any} */ e) => {
  if (!saidPs) console.error(`Postbox couldn’t list processes with ps, so it can’t start, watch or stop background processes: ${e?.message ?? 'no output'}`);
  saidPs = true;
};

/** @param {TimedProc} p @returns {Ident} */
const identOf = (p) => ({ pid: p.pid, started: p.started });

/** Whether `pid` descends from `ancestor` through parent pids, in one snapshot. @param {Map<number, TimedProc>} byPid */
export function descends(byPid, pid, ancestor) {
  let p = byPid.get(pid);
  for (let depth = 0; p && depth < MAX_DEPTH; depth++) {
    if (p.ppid === ancestor) return true;
    if (p.ppid <= 1) return false;
    p = byPid.get(p.ppid);
  }
  return false;
}

/**
 * The leader to bind to a registration, from one snapshot, or null. A candidate is bound only when all of these hold:
 * its command line is the leader’s copy of the launcher for this id; it leads its own group (pid = pgid); its parent
 * is the foreground launcher for the same id; that launcher descends from the owning turn’s backend process; and both
 * started no earlier than the registration, to the second ps reports. Two that match: the first is bound, and the
 * other, never signaled, runs nothing and times out.
 * @param {TimedProc[]} procs @param {{ id: string, createdAt: number }} reg
 * @param {{ backendPid: number, launcher: string }} at  the turn’s backend pid, and the launcher’s real path
 * @returns {Ident | null}
 */
export function findLeader(procs, reg, { backendPid, launcher }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const since = Math.floor(reg.createdAt / 1000) * 1000;
  const after = (/** @type {TimedProc} */ p) => startMs(p.started) >= since;
  for (const p of procs) {
    const own = launchOf(p.command, launcher);
    if (!own?.leader || own.id !== reg.id || p.pid !== p.pgid || !after(p)) continue;
    const parent = byPid.get(p.ppid);
    const fg = parent ? launchOf(parent.command, launcher) : null;
    if (!parent || !fg || fg.leader || fg.id !== reg.id || !after(parent)) continue;
    if (descends(byPid, parent.pid, backendPid)) return identOf(p);
  }
  return null;
}

/** Whether a process is alive as recorded: the same pid with the same start time. @param {TimedProc[]} procs @param {Ident} who */
export const aliveAs = (procs, who) => procs.some((p) => p.pid === who.pid && p.started === who.started);

/** Whether a recorded leader is alive and still leads its group. @param {TimedProc[]} procs @param {Ident} leader */
export const leaderAlive = (procs, leader) => procs.some((p) => p.pid === leader.pid && p.started === leader.started && p.pgid === p.pid);

/** A group’s members now, by pid and start time, at most MAX_MEMBERS. @param {TimedProc[]} procs @param {number} pgid @returns {Ident[]} */
export const membersOf = (procs, pgid) =>
  procs
    .filter((p) => p.pgid === pgid)
    .slice(0, MAX_MEMBERS)
    .map(identOf);

/**
 * The recorded members, other than the leader, that are still alive as recorded: what a leader that died left running.
 * A process that joined the group after the last poll isn’t among them, and isn’t signaled.
 * @param {TimedProc[]} procs @param {Ident[]} members @param {number} leaderPid @returns {Ident[]}
 */
export const leftovers = (procs, members, leaderPid) => members.filter((m) => m.pid !== leaderPid && aliveAs(procs, m));

/**
 * The recorded pids that ps shows with another start time: processes Postbox can’t confirm are its own, which it never
 * signals, and names on the process’s end. @param {TimedProc[]} procs @param {Ident[]} recorded @returns {number[]}
 */
export const unconfirmed = (procs, recorded) => recorded.filter((r) => procs.some((p) => p.pid === r.pid && p.started !== r.started)).map((r) => r.pid);
