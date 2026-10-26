// What the host says about a process, so the daemon signals a turn’s process group only while it’s still the runner
// that runner.json describes (#120; shared/remote-protocol.mjs, RunnerRecord). A process ID alone can belong to another
// process after a reboot or once IDs wrap, so a runner is the same only when its PID is alive and the boot ID and its
// start time both still match.
//
// Hosts are Linux, where these are /proc facts: the boot ID from /proc/sys/kernel/random/boot_id, and the start time,
// field 22 of /proc/<pid>/stat, in clock ticks since boot (proc_pid_stat(5)). On macOS, where the tests and a
// developer run the host code, there’s no /proc, so the same facts come from `sysctl kern.bootsessionuuid` and
// `ps -o lstart=`, a start time in seconds since the epoch. Each is compared only with a value read the same way on
// the same machine, so the units never meet. Every reader is injectable, and each returns null when the fact isn’t
// there, never throws.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** proc_pid_stat(5) numbers fields from 1; the text after comm’s closing paren starts at field 3, the state. */
const PPID_FIELD = 4;
const PGID_FIELD = 5;
const START_FIELD = 22;
const AFTER_COMM = 3;

/**
 * @typedef {{ readFile?: (path: string, enc: 'utf8') => string, run?: (file: string, args: string[]) => string,
 *   platform?: string, kill?: (pid: number, signal: 0) => unknown }} ProcOpts
 *   run: runs a program and returns its stdout (macOS only); kill: process.kill, to see whether a PID is alive.
 */

/** @param {string} file @param {string[]} args */
const runProgram = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });

/** This boot’s ID, a lowercase UUID, or null where the host doesn’t give one. @param {ProcOpts} [opts] */
export function bootId({ readFile = readFileSync, run = runProgram, platform = process.platform } = {}) {
  try {
    const id = (platform === 'darwin' ? run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']) : readFile('/proc/sys/kernel/random/boot_id', 'utf8'))
      .trim()
      .toLowerCase();
    return BOOT_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The fields of a /proc/<pid>/stat line Stop needs: ppid (field 4), pgid (field 5) and the start time (field 22), or
 * null. The command name, field 2, is in parentheses and may itself contain spaces and parentheses, so the fields are
 * counted from its last closing paren, never by splitting the whole line.
 * @param {string} text @returns {{ pid: number, ppid: number, pgid: number, startTime: number } | null}
 */
export function parseStat(text) {
  const close = text.lastIndexOf(')');
  if (close === -1) return null;
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const num = (field) => {
    const v = rest[field - AFTER_COMM];
    if (v === undefined || !/^\d{1,16}$/.test(v)) return null;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  };
  const pid = /^\s*(\d{1,10})\s/.exec(text)?.[1];
  const [ppid, pgid, start] = [num(PPID_FIELD), num(PGID_FIELD), num(START_FIELD)];
  if (pid === undefined || ppid === null || pgid === null || start === null) return null;
  return { pid: Number(pid), ppid, pgid, startTime: start };
}

/** Field 22 of a /proc/<pid>/stat line, the start time, or null. @param {string} text */
export const parseStartTime = (text) => parseStat(text)?.startTime ?? null;

/** When a process started, as an integer that stays the same for its life, or null if there’s no such process. @param {number} pid @param {ProcOpts} [opts] */
export function startTime(pid, { readFile = readFileSync, run = runProgram, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (platform !== 'darwin') return parseStartTime(readFile(`/proc/${pid}/stat`, 'utf8'));
    // “Fri Oct 23 19:36:46 2026”, in UTC since runProgram sets TZ.
    const at = Date.parse(`${run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]).trim()} UTC`);
    return Number.isSafeInteger(at) && at >= 0 ? at / 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Whether runner.json’s process is still running: its PID is alive (and ours to signal), and this boot and its start
 * time are the recorded ones. False for anything it can’t confirm.
 * @param {{ pid: number, bootId: string, startTime: number }} record @param {ProcOpts} [opts]
 */
export function sameProcess(record, opts = {}) {
  const { kill = process.kill } = opts;
  if (!record || !Number.isSafeInteger(record.pid) || record.pid < 2) return false;
  try {
    kill(record.pid, 0);
  } catch {
    // ESRCH: gone. EPERM: alive, but another user’s, so not a runner of ours.
    return false;
  }
  const boot = bootId(opts);
  if (boot === null || boot !== record.bootId) return false;
  const start = startTime(record.pid, opts);
  return start !== null && start === record.startTime && !zombie(record.pid, opts);
}

/**
 * Whether a process has exited and waits only to be reaped (state Z, or X once it’s being reaped): signal 0 still reaches
 * it and its start time still reads, but it runs nothing. A container whose PID 1 doesn’t reap leaves a killed daemon
 * like this for good, and counting it as alive would stop a new one from ever starting. False when it can’t tell.
 * @param {number} pid @param {ProcOpts} [opts]
 */
export function zombie(pid, { readFile = readFileSync, run = runProgram, platform = process.platform } = {}) {
  try {
    if (platform !== 'darwin') {
      const text = readFile(`/proc/${pid}/stat`, 'utf8');
      const state = text
        .slice(text.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0];
      return state === 'Z' || state === 'X';
    }
    return /^[ZX]/.test(run('/bin/ps', ['-o', 'state=', '-p', String(pid)]).trim());
  } catch {
    return false;
  }
}

// ── The start lock’s owner ──
//
// A version’s start lock (~/.postbox-remote/locks/<version>.lock, a folder made with mkdir) holds its owner’s record,
// LOCK_OWNER: { pid, bootId, startTime }, as daemon.pid does, written beside it and renamed in, so it’s read whole or
// not at all. daemon.mjs’s attach, install.mjs’s script and cleanup.mjs’s retirement judge it the same way: the lock is
// held while its owner is the same process (sameProcess here, `live` in the script), whatever its age. A lock with no
// record is one just made, held for a grace period (daemon.mjs’s LOCK_STALE_MS), then stale. The script writes the PID
// alone where there’s no /proc (macOS), as its `live` checks only the PID there; such a record is held while that PID
// is alive. The break locks that one stale lock is removed under, `<lock>.break` and daemon.pid.break, hold their
// breaker’s record the same way and are judged by it (daemon.mjs’s holdBreak, the script’s takeb and unb).

/** The owner record’s name in the start lock’s folder. */
export const LOCK_OWNER = 'owner';

/**
 * A start lock owner record’s text, parsed: the whole record, the PID alone, or null for text that isn’t a record,
 * which is a dead owner’s (it’s renamed in whole, so it isn’t one being written).
 * @param {string} text @returns {{ pid: number, bootId?: string, startTime?: number } | null}
 */
export function parseLockOwner(text) {
  try {
    const r = JSON.parse(text);
    if (!r || !Number.isSafeInteger(r.pid) || r.pid < 2) return null;
    if (typeof r.bootId === 'string' && Number.isSafeInteger(r.startTime)) return { pid: r.pid, bootId: r.bootId, startTime: r.startTime };
    if (r.bootId === undefined && r.startTime === undefined) return { pid: r.pid };
  } catch {}
  return null;
}

/**
 * Whether a start lock’s owner is still running: sameProcess for a whole record, an alive PID for a PID alone.
 * @param {{ pid: number, bootId?: string, startTime?: number } | null} owner
 * @param {{ sameProcess?: (r: { pid: number, bootId: string, startTime: number }) => boolean | Promise<boolean>, kill?: (pid: number, signal: 0) => unknown }} [o]
 * @returns {boolean | Promise<boolean>}
 */
export function lockOwnerLive(owner, { sameProcess: same = sameProcess, kill = process.kill } = {}) {
  if (!owner) return false;
  if (owner.bootId !== undefined && owner.startTime !== undefined) return same({ pid: owner.pid, bootId: owner.bootId, startTime: owner.startTime });
  try {
    kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── A turn’s tool shells ──
//
// Claude Code runs each Bash call in a session of its own (setsid), so its tool shells aren’t in the turn’s process
// group, and SIGKILL to that group leaves them running with ppid 1 (recorded with ps on claude 2.1.296;
// server/adapters/process-group.mjs, whose shellGroups this mirrors, has the record). Stop finds them by their parent:
// a process whose parent is in the turn’s group, or in a group already found this way, and that leads a group of its
// own. Each group is recorded with its members’ PIDs and start times while their parent is still alive, since once the
// CLI dies they’re only children of PID 1. Before a group is signaled, one of its recorded members must still be the
// same process (alive, with its start time) and still in that group; a group nobody recorded is still in has gone, and
// its ID may now be another process’s.

/** @typedef {{ pid: number, ppid: number, pgid: number, startTime: number }} ProcEntry */
/** @typedef {{ pgid: number, members: { pid: number, startTime: number }[] }} ToolGroup */

/**
 * Every process this host lets us see: /proc/<pid>/stat on Linux, `ps -A -o pid=,ppid=,pgid=,lstart=` on macOS (start
 * times in the same units startTime gives there). Null if the list can’t be read.
 * @param {ProcOpts & { readdir?: (path: string) => string[] }} [opts] @returns {ProcEntry[] | null}
 */
export function listProcesses({ readFile = readFileSync, readdir = readdirSync, run = runProgram, platform = process.platform } = {}) {
  try {
    if (platform === 'darwin') return parsePs(run('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=']));
    /** @type {ProcEntry[]} */
    const out = [];
    for (const name of readdir('/proc')) {
      if (!/^\d{1,10}$/.test(name)) continue;
      let text;
      try {
        text = readFile(`/proc/${name}/stat`, 'utf8');
      } catch {
        continue; // it exited between the listing and the read
      }
      const e = parseStat(text);
      if (e && String(e.pid) === name) out.push(e);
    }
    return out;
  } catch {
    return null;
  }
}

/** `ps -A -o pid=,ppid=,pgid=,lstart=` output, with lstart (“Fri Oct 23 19:36:46 2026”, UTC) in seconds. @param {string} text */
export function parsePs(text) {
  /** @type {ProcEntry[]} */
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d{1,10})\s+(\d{1,10})\s+(\d{1,10})\s+(\S.*\S)\s*$/.exec(line);
    if (!m) continue;
    const at = Date.parse(`${m[4]} UTC`);
    if (Number.isSafeInteger(at) && at >= 0) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), startTime: at / 1000 });
  }
  return out;
}

/**
 * The tool shells’ groups under a turn’s process group, found transitively: a process whose parent is in the turn’s
 * group or a group found so far, and that leads its own group. Each with its members as they are now. Null if the
 * processes can’t be listed.
 * @param {number} pgid  the turn’s group, the runner’s PID @param {{ list?: () => ProcEntry[] | null }} [opts]
 * @returns {ToolGroup[] | null}
 */
export function toolGroups(pgid, { list = listProcesses } = {}) {
  const procs = list();
  if (!procs) return null;
  /** @type {Map<number, ProcEntry[]>} */
  const byGroup = new Map();
  for (const p of procs) byGroup.set(p.pgid, [...(byGroup.get(p.pgid) ?? []), p]);
  const under = new Set((byGroup.get(pgid) ?? []).map((p) => p.pid));
  /** @type {Map<number, ToolGroup>} */
  const found = new Map();
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (p.pid !== p.pgid || p.pgid === pgid || found.has(p.pgid) || !under.has(p.ppid)) continue;
      const members = byGroup.get(p.pgid) ?? [];
      found.set(p.pgid, { pgid: p.pgid, members: members.map((m) => ({ pid: m.pid, startTime: m.startTime })) });
      for (const m of members) under.add(m.pid);
      grew = true;
    }
  }
  return [...found.values()];
}

/**
 * Of recorded tool groups, the ones still there: a recorded member is alive, with its start time, in that group.
 * @param {ToolGroup[]} groups @param {{ list?: () => ProcEntry[] | null }} [opts] @returns {ToolGroup[]}
 */
export function liveGroups(groups, { list = listProcesses } = {}) {
  if (!groups.length) return [];
  const procs = list();
  if (!procs) return [];
  const now = new Map(procs.map((p) => [p.pid, p]));
  return groups.filter((g) =>
    g.members.some((m) => {
      const p = now.get(m.pid);
      return p !== undefined && p.startTime === m.startTime && p.pgid === g.pgid;
    }),
  );
}
