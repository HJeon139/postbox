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
//
// A job to keep is found by what its shell runs (runsCommand), which isn’t always the command Claude Code was given: it
// applies a leading `cd <dir> &&` itself, for one (#164). A job Postbox still can’t tell apart is never killed: the shells
// it might be stay running with it, so the person’s choice to keep it holds, and its own Stop stops them all.

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
 * What a tool shell runs, or null for a process that isn’t one. Claude Code wraps a Bash call as `$SHELL -c '… eval
 * <command quoted> < /dev/null && pwd -P >| …'`, quoting a ' inside it as '"'"' (recorded in the pull request for #126);
 * '\'' is the other usual form.
 * @param {string} line  the shell’s command line, as ps shows it
 */
export function evalOf(line) {
  const m = /\beval '((?:[^']|'"'"'|'\\'')*)'/.exec(String(line ?? ''));
  // In one pass, as the match read it: undoing one style, then the other, would turn the command '\'' into '.
  return m ? m[1].replace(/'"'"'|'\\''/g, "'") : null;
}

/** A command as it runs: without the leading `cd <dir> &&` that Claude Code applies itself (#164), and its whitespace. */
const bare = (command) => {
  let c = String(command ?? '').trim();
  for (let m; (m = /^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/.exec(c)); ) c = c.slice(m[0].length);
  return c.replace(/\s+/g, ' ');
};

/**
 * Whether a tool shell runs this command: what it evals is the command, give or take a leading `cd <dir> &&` and
 * whitespace. No looser: a job that matches no shell is kept with all of them, but one that matches the wrong shell
 * leaves its own to be killed as a foreground call.
 * @param {Proc} shell @param {string} command
 */
export function runsCommand(shell, command) {
  const ran = evalOf(shell.command);
  const want = bare(command);
  return ran !== null && want !== '' && bare(ran) === want;
}

/**
 * Signals a process group; a child without a pid (a test’s fake) gets the signal itself. A remote child (#120,
 * server/remote/process.mjs) always does: it has no process here, and its kill sends the daemon’s `stop`.
 */
export function signalGroup(child, signal, kill = process.kill) {
  if (child?.remote) return remoteKill(child, signal);
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
 * A kept job’s process group, with its leader’s command line when it was kept: a later check that the group is still
 * the job’s compares that, not the job’s command, which may not match it (#164).
 * @typedef {{ pgid: number, command: string }} KeptGroup
 */

/**
 * Stops one turn’s CLI and everything it started. Resolves once the signals are sent with the background jobs it kept,
 * [{ id, pgid, groups }], and `gone`, which resolves once the CLI’s whole group has exited. That’s later than the spawned
 * process when it’s a launcher: a shim can exit on SIGINT while the CLI under it, in the same group, runs on (#126), so
 * the group gets SIGKILL after the grace period unless it’s empty by then.
 *
 * With jobs to keep, the CLI gets SIGKILL at once whatever happens, since its SIGINT would stop them. A job whose shell
 * runsCommand finds is kept in that shell’s group. One it can’t find is never killed (#164): every other tool shell may
 * be it, so they’re all kept as its groups, and the shells that are kept jobs’ own are the only ones known not to be. A
 * job with no tool shell left at all isn’t in kept.
 * @param {any} child  the CLI, as spawned (detached)
 * @param {{ keep?: { id: string, command: string }[], exited: Promise<any>, graceMs?: number, pollMs?: number, kill?: KillFn,
 *           list?: () => Promise<Proc[]> }} opts  exited: resolves when the spawned process has exited
 * @returns {Promise<{ kept: { id: string, pgid: number, groups: KeptGroup[] }[], gone: Promise<void> }>}
 */
export async function stopTurn(child, { keep = [], exited, graceMs = GRACE_MS, pollMs = 100, kill = process.kill, list = listProcesses }) {
  if (child?.remote) return stopRemote(child);
  const pid = child?.pid;
  const shells = pid ? shellGroups(await list().catch(() => []), pid) : [];
  /** @type {{ id: string, pgid: number, groups: KeptGroup[] }[]} */
  const kept = [];
  if (keep.length) {
    const used = new Set();
    const found = keep.map((j) => {
      const s = shells.find((x) => !used.has(x.pgid) && runsCommand(x, j.command));
      if (s) used.add(s.pgid);
      return { id: j.id, shell: s ?? null };
    });
    /** @param {Proc} s @returns {KeptGroup} */
    const group = (s) => ({ pgid: s.pgid, command: s.command });
    const rest = shells.filter((s) => !used.has(s.pgid)).map(group);
    for (const f of found) {
      if (f.shell) kept.push({ id: f.id, pgid: f.shell.pgid, groups: [group(f.shell)] });
      else if (rest.length) kept.push({ id: f.id, pgid: rest[0].pgid, groups: rest });
    }
    signalGroup(child, 'SIGKILL', kill);
    // The other tool shells are the turn’s foreground calls, once every job is found; otherwise they may be a job.
    if (found.every((f) => f.shell)) for (const s of rest) signalPgid(s.pgid, 'SIGKILL', kill);
  } else signalGroup(child, 'SIGINT', kill);
  const others = shells.filter((s) => !kept.some((k) => k.groups.some((g) => g.pgid === s.pgid)));
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
 * null if no shell runs its command. For a remote child it’s false, at once: a job’s own Stop isn’t offered for a turn
 * on a host (#120, remote-hosts.md “Stop, in all three”), and like null it’s falsy, so a caller that only checks for a
 * group still refuses.
 * @param {any} child @param {{ command: string }} job
 * @param {{ kill?: KillFn, list?: () => Promise<Proc[]>, graceMs?: number }} [opts]
 */
export async function stopJobUnder(child, job, { kill = process.kill, list = listProcesses, graceMs = GRACE_MS } = {}) {
  if (child?.remote) return false;
  if (!child?.pid) return null;
  const shell = shellGroups(await list().catch(() => []), child.pid).find((s) => runsCommand(s, job.command));
  if (!shell) return null;
  stopPgid(shell.pgid, { kill, graceMs });
  return shell.pgid;
}

/**
 * Stop for a turn on a remote host (#120). The child is server/remote/process.mjs’s: its kill sends the daemon’s `stop`
 * (the daemon sends SIGINT, then SIGKILL after its own grace period, to the runner’s group on the host), and `gone`
 * resolves when the daemon reports the turn ended, as the child’s exit or close. The local kill and ps are never used:
 * a host’s process ID means nothing here, and -pid on the laptop would signal an unrelated group. No job is kept,
 * whatever `keep` asked for: keeping jobs isn’t offered for a remote turn, and the adapter reports each one as stopped.
 * @param {any} child
 * @returns {Promise<{ kept: { id: string, pgid: number, groups: KeptGroup[] }[], gone: Promise<void> }>}
 */
async function stopRemote(child) {
  const gone = new Promise((resolve) => {
    if (child.ended || child.exitCode != null || child.signalCode != null) return resolve(undefined);
    child.once('exit', () => resolve(undefined));
    child.once('close', () => resolve(undefined));
  });
  remoteKill(child, 'SIGINT');
  return { kept: [], gone };
}

/** A remote child’s kill, which never throws here: a stop that couldn’t be sent is the connection’s to report. */
function remoteKill(child, signal) {
  try {
    return child.kill(signal) ?? false;
  } catch {
    return false;
  }
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
