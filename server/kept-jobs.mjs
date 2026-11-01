// The background jobs Postbox kept running after a Stop (#129, #164): which they are, the poll that sees one end, and
// their own Stop. Moved from server/runtime.mjs; each function takes the runtime first.

import { runsCommand, stopPgid } from './adapters/process-group.mjs';
import { httpError } from './helpers.mjs';

/** How often Postbox checks whether a background job it kept running has ended (#129). */
const KEPT_POLL_MS = 5000;

/** The kept jobs, everywhere. */
export function keptJobs(rt) {
  return Object.values(rt.s.sessions).flatMap((se) => (se.jobs ?? []).filter((j) => j.kept && keptGroupsOf(j).length));
}

/** Checks on the jobs Postbox kept running, until none is left: one whose process group is gone has ended. */
export function watchKept(rt) {
  if (rt.keptPoll) return;
  rt.keptPoll = setInterval(() => rt.pollKept(), KEPT_POLL_MS);
  rt.keptPoll.unref?.();
}
export async function pollKept(rt) {
  if (!rt.store.writable) return; // a job’s end is recorded at the next tick after Retry, not into memory only
  if (!rt.keptJobs().length) return;
  const procs = await rt.listProcesses().catch(() => null);
  if (!procs) return;
  for (const j of rt.keptJobs()) if (!liveGroups(j, procs).length) rt.endJob(j.sessionId, j.id, 'done');
  if (!rt.keptJobs().length && rt.keptPoll) {
    clearInterval(rt.keptPoll);
    rt.keptPoll = null;
  }
}

/** Stops a session’s kept jobs, when it’s deleted for good or Postbox shuts down: nothing else would know of them. */
export async function stopKeptJobs(rt, sessionIds, why) {
  const jobs = rt.keptJobs().filter((j) => sessionIds.includes(j.sessionId));
  if (!jobs.length) return;
  const procs = await rt.listProcesses().catch(() => []);
  for (const j of jobs) {
    for (const g of liveGroups(j, procs)) stopPgid(g.pgid, { kill: rt.signalProcess });
    rt.endJob(j.sessionId, j.id, 'stopped', why);
  }
}

/**
 * A background job’s own Stop (#129). One Postbox kept running is signaled by its process group; one still under its
 * agent’s CLI is found there by the adapter, and the CLI reports how it ended.
 */
export async function stopJob(rt, sessionId, jobId) {
  const se = rt.session(sessionId);
  const job = (se.jobs ?? []).find((j) => j.id === jobId);
  if (!job) throw httpError(409, 'That background job already ended.');
  if (job.kept) {
    // Only the groups still the job’s: one that ended may have left its id to another process.
    const procs = await rt.listProcesses().catch(() => []);
    const stopped = new Set(liveGroups(job, procs).map((g) => g.pgid));
    for (const pgid of stopped) stopPgid(pgid, { kill: rt.signalProcess });
    rt.endJob(sessionId, jobId, 'stopped', null, { by: 'you' });
    // Another kept job Postbox couldn’t tell apart from it shares those groups, still its own (#164): it stopped with them (#167).
    const why = `Postbox couldn’t tell its processes from those of the background job “${job.label}”, so stopping that job stopped this one too.`;
    // Only when every group still its own was signaled: one left running keeps the job listed, so it can be stopped.
    for (const o of keptJobs(rt)) {
      const own = liveGroups(o, procs);
      if (own.length && own.every((g) => stopped.has(g.pgid))) rt.endJob(o.sessionId, o.id, 'stopped', why, { by: 'you' });
    }
    return { ok: true };
  }
  const turn = rt.turns.get(sessionId);
  const stopJob = turn?.id === job.turnId ? turn.control?.stopJob : null;
  if (typeof stopJob !== 'function') throw httpError(409, `Postbox can’t reach that job’s process. Stop @${se.handle} to stop it.`);
  const mark = (stopping) =>
    rt.updateSession(sessionId, { jobs: (rt.s.sessions[sessionId]?.jobs ?? []).map((j) => (j.id === jobId ? { ...j, stopping } : j)) });
  mark(true);
  const pgid = await stopJob({ id: job.id, command: job.command });
  if (!pgid) {
    mark(false);
    throw httpError(409, `Postbox couldn’t find that job’s process. Stop @${se.handle} to stop it.`);
  }
  return { ok: true };
}

/**
 * A kept job’s process groups, with their leaders’ command lines when it was kept (#164). A job kept before those were
 * recorded has only its pgid. Bounded and checked: these come from an adapter, or from saved state.
 * @param {{ pgid?: unknown, groups?: unknown }} job
 * @returns {{ pgid: number, command: string|null }[]}
 */
export function keptGroupsOf(job) {
  const ok = (n) => Number.isInteger(n) && n > 1;
  if (Array.isArray(job.groups))
    return job.groups
      .filter((g) => ok(g?.pgid))
      .slice(0, 20)
      .map((g) => ({ pgid: g.pgid, command: typeof g.command === 'string' ? g.command.slice(0, 8000) : null }));
  return ok(job.pgid) ? [{ pgid: /** @type {number} */ (job.pgid), command: null }] : [];
}

/**
 * A kept job’s groups that are still its own: something is in them, and the leader, if still there, is the process it
 * was when the job was kept (or, for a job from before that was recorded, runs the job’s command). A group can’t lose
 * its id while anything is in it, but once it’s empty the id can go to another.
 * @param {{ pgid?: number, groups?: unknown, command: string }} job @param {import('./adapters/process-group.mjs').Proc[]} procs
 */
function liveGroups(job, procs) {
  return keptGroupsOf(job).filter((g) => {
    const members = procs.filter((p) => p.pgid === g.pgid);
    const leader = members.find((p) => p.pid === g.pgid);
    return members.length > 0 && (!leader || (g.command !== null ? leader.command === g.command : runsCommand(leader, job.command)));
  });
}
