// How a CLI turn’s processes are stopped (#126). Each turn’s CLI starts in its own process group (spawn with
// detached: true), so Stop reaches every process under a launcher, such as a shim that starts the real CLI.
//
// Claude Code runs each Bash call, in the foreground or in the background, in a session of its own (setsid), so its
// tool shells aren’t in that group. Recorded with ps on claude 2.1.296 (the pull request for #126 has the output):
// - SIGINT to the CLI: it stops its tool shells itself (task_notification “stopped”), then exits.
// - SIGKILL to the CLI: its tool shells live on, with ppid 1. A background job keeps writing to its output file.
// So Stop sends SIGINT to the group, and if the CLI hasn’t exited after the grace period, SIGKILL to the group and to
// every tool shell’s group it had. To keep a background job running, the CLI gets SIGKILL at once, since its SIGINT
// handler would stop the job, and the job’s group is kept so Postbox can stop it later.

import { execFile } from 'node:child_process';

/** Stop’s grace period between SIGINT and SIGKILL. */
export const GRACE_MS = 3000;

/**
 * @typedef {{ pid: number, ppid: number, pgid: number, command: string }} Proc
 * @typedef {(pid: number, signal: NodeJS.Signals | 0) => any} KillFn
 */

/** Parses `ps -o pid=,ppid=,pgid=,command=` output. */
export function parsePs(text) {
  /** @type {Proc[]} */
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] });
  }
  return out;
}

/**
 * Every process on this computer, from ps (an argument array, no shell), or [] if ps can’t run.
 * @returns {Promise<Proc[]>}
 */
export function listProcesses() {
  const failed = (e) => {
    // Without ps, Stop still signals the CLI’s group, but can’t reach the tool shells it started: say why, once.
    if (!psFailed) console.error(`Postbox couldn’t list processes with ps, so Stop can’t reach an agent’s tool shells: ${e.message}`);
    psFailed = true;
    return [];
  };
  return new Promise((resolve) => {
    try {
      execFile('ps', ['axww', '-o', 'pid=,ppid=,pgid=,command='], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
        resolve(err ? failed(err) : parsePs(String(out))),
      );
    } catch (e) {
      resolve(failed(e));
    }
  });
}
let psFailed = false;

/** The tool shells under a CLI’s process group: processes started by one in the group, each leading a group of its own. */
export function shellGroups(procs, pgid) {
  const members = new Set(procs.filter((p) => p.pgid === pgid).map((p) => p.pid));
  return procs.filter((p) => members.has(p.ppid) && p.pgid === p.pid && p.pgid !== pgid);
}

/**
 * Whether a tool shell runs this command. Claude Code wraps a Bash call as `$SHELL -c '… eval <command quoted> < /dev/null
 * && pwd -P >| …'`, quoting a ' inside it as '"'"' (recorded in the pull request for #126); '\'' is the other usual form.
 */
export function runsCommand(shell, command) {
  const c = String(command ?? '');
  if (!c) return false;
  return [`eval '${c.replaceAll("'", `'"'"'`)}'`, `eval '${c.replaceAll("'", `'\\''`)}'`].some((q) => shell.command.includes(q));
}

/** Signals a process group; a child without a pid (a test’s fake) gets the signal itself. */
export function signalGroup(child, signal, kill = process.kill) {
  try {
    if (child?.pid) {
      kill(-child.pid, signal);
      return true;
    }
  } catch {
    // The group is gone already: signal the child itself, which says whether it’s still there.
  }
  try {
    return child?.kill?.(signal) ?? false;
  } catch {
    return false;
  }
}

/** Signals a group by its id; false if it’s gone. */
export function signalPgid(pgid, signal, kill = process.kill) {
  try {
    kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops one turn’s CLI and everything it started. Resolves once the signals are sent with the background jobs it kept,
 * [{ id, pgid }], and `gone`, which resolves once the CLI’s whole group has exited. That’s later than the spawned process
 * when it’s a launcher: a shim can exit on SIGINT while the CLI under it, in the same group, runs on (#126), so the
 * group gets SIGKILL after the grace period unless it’s empty by then. A job to keep whose shell can’t be found isn’t
 * kept: everything stops, as for a plain Stop, and the job is left out of kept.
 * @param {any} child  the CLI, as spawned (detached)
 * @param {{ keep?: { id: string, command: string }[], exited: Promise<any>, graceMs?: number, pollMs?: number, kill?: KillFn,
 *           list?: () => Promise<Proc[]> }} opts  exited: resolves when the spawned process has exited
 * @returns {Promise<{ kept: { id: string, pgid: number }[], gone: Promise<void> }>}
 */
export async function stopTurn(child, { keep = [], exited, graceMs = GRACE_MS, pollMs = 100, kill = process.kill, list = listProcesses }) {
  const pid = child?.pid;
  const shells = pid ? shellGroups(await list().catch(() => []), pid) : [];
  /** @type {{ id: string, pgid: number }[]} */
  let kept = [];
  if (keep.length) {
    const used = new Set();
    const found = keep.map((j) => {
      const s = shells.find((x) => !used.has(x.pgid) && runsCommand(x, j.command));
      if (s) used.add(s.pgid);
      return { id: j.id, pgid: s?.pgid ?? null };
    });
    if (found.every((f) => f.pgid !== null)) {
      kept = /** @type {{ id: string, pgid: number }[]} */ (found);
      signalGroup(child, 'SIGKILL', kill);
      for (const s of shells) if (!used.has(s.pgid)) signalPgid(s.pgid, 'SIGKILL', kill);
    }
  }
  if (!kept.length) signalGroup(child, 'SIGINT', kill);
  const others = shells.filter((s) => !kept.some((k) => k.pgid === s.pgid));
  // A fake child in a test has no pid: it’s gone when it has exited.
  if (!pid) return { kept, gone: exited.then(() => {}) };
  // Its timers hold Postbox open until the group is gone, at most graceMs + 5 s: a stop in progress should finish.
  const gone = new Promise((resolve) => {
    let leaderExited = false;
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(late);
      clearInterval(watch);
      for (const s of others) signalPgid(s.pgid, 'SIGKILL', kill);
      resolve(undefined);
    };
    // The grace period is over: SIGKILL to whatever is left of the group and its tool shells. A group can’t lose its id
    // to another while any process is in it, so this reaches only the turn’s own.
    const timer = setTimeout(() => {
      signalGroup(child, 'SIGKILL', kill);
      for (const s of others) signalPgid(s.pgid, 'SIGKILL', kill);
    }, graceMs);
    // A group that outlives SIGKILL (a process stuck in the kernel) can’t hold the session forever: say so, and go on.
    const late = setTimeout(() => {
      console.error(`Postbox stopped a turn, but process group ${pid} is still there ${Math.round((graceMs + 5000) / 1000)} s later.`);
      finish();
    }, graceMs + 5000);
    const watch = setInterval(() => {
      if (leaderExited && !groupAlive(pid, kill)) finish();
    }, pollMs);
    exited.then(() => {
      leaderExited = true;
      if (!groupAlive(pid, kill)) finish();
    });
  });
  return { kept, gone };
}

/**
 * Stops one background job by its tool shell, found under a CLI that’s still running. Resolves to the job’s group, or
 * null if no shell runs its command.
 * @param {any} child @param {{ command: string }} job
 * @param {{ kill?: KillFn, list?: () => Promise<Proc[]>, graceMs?: number }} [opts]
 */
export async function stopJobUnder(child, job, { kill = process.kill, list = listProcesses, graceMs = GRACE_MS } = {}) {
  if (!child?.pid) return null;
  const shell = shellGroups(await list().catch(() => []), child.pid).find((s) => runsCommand(s, job.command));
  if (!shell) return null;
  stopPgid(shell.pgid, { kill, graceMs });
  return shell.pgid;
}

/** SIGINT to a group, then SIGKILL if it’s still there after the grace period. */
export function stopPgid(pgid, { kill = process.kill, graceMs = GRACE_MS } = {}) {
  if (!signalPgid(pgid, 'SIGINT', kill)) return false;
  const timer = setTimeout(() => signalPgid(pgid, 'SIGKILL', kill), graceMs);
  timer.unref?.();
  return true;
}

/** Whether any process in a group is still running. */
export function groupAlive(pgid, kill = process.kill) {
  return signalPgid(pgid, 0, kill);
}
