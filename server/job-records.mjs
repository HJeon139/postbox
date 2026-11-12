// A turn's background jobs (#129): what its adapter reports of each, a job's end and the step that shows it, the jobs
// that went with their CLI, and those a restart leaves behind. Jobs Postbox kept running after a Stop are watched in
// server/kept-jobs.mjs. Moved from server/runtime.mjs (#1236); each function here takes the runtime first.

import { clipText } from './helpers.mjs';
import { keptGroupsOf } from './kept-jobs.mjs';
import { stepState } from './step-text.mjs';

/** The background jobs Postbox keeps on a session, at most. */
const MAX_JOBS = 50;
// Postbox never kills a job you kept (#164), but one with no process left under its agent couldn’t be kept either.
const KEEP_LOST = 'Postbox couldn’t find its process to keep it running: it may have ended with the agent, and Postbox can’t show it or stop it.';
/** What the person and the agent are told when Postbox couldn’t tell which of a turn’s processes a kept job was (#164). */
const keepUnsure = (n) => `Postbox couldn’t tell which of ${n} processes is this job, so it kept them all running; stopping the job stops them all.`;

/** A turn’s background jobs still running under its CLI (not those Postbox kept running after an earlier Stop). */
export function runningJobs(rt, sessionId, turnId) {
  return (rt.s.sessions[sessionId]?.jobs ?? []).filter((j) => j.turnId === turnId && j.state === 'running' && !j.kept);
}

/** What the adapter reports about a background job (ctx.job), bounded. */
export function recordJob(rt, turn, j) {
  const se = rt.s.sessions[turn.sessionId];
  if (!se || !j || typeof j.id !== 'string' || !j.id) return;
  const id = j.id.slice(0, 60);
  const jobs = se.jobs ?? [];
  const old = jobs.find((x) => x.id === id);
  if (!old) {
    if (j.state !== 'running') return;
    const job = {
      id,
      sessionId: se.id,
      turnId: turn.id,
      threadId: turn.threadId,
      itemId: turn.first,
      toolUseId: String(j.toolUseId ?? '').slice(0, 100),
      label: clipText(String(j.label ?? 'Background job'), 200),
      // Whole, up to a bound: Postbox finds the job’s process by its command.
      command: String(j.command ?? '').slice(0, 8000),
      outputFile: typeof j.outputFile === 'string' && j.outputFile ? j.outputFile.slice(0, 1000) : null,
      startedAt: Date.now(),
      state: 'running',
    };
    // At the bound, the oldest job Postbox didn’t keep goes first: a kept one has no other record.
    const all = [...jobs, job];
    const drop = all.length > MAX_JOBS ? all.find((x) => !x.kept) : null;
    rt.updateSession(se.id, { jobs: drop ? all.filter((x) => x !== drop) : all });
    return;
  }
  const groups = j.kept === true ? keptGroupsOf(j) : [];
  if (groups.length) {
    turn.keptAny = true;
    rt.updateSession(se.id, { jobs: jobs.map((x) => (x.id === id ? { ...x, kept: true, pgid: groups[0].pgid, groups } : x)) });
    // Postbox couldn’t tell which of the turn’s processes was the job, so it kept them all (#164): say so.
    const unsure = groups.length > 1 ? keepUnsure(groups.length) : null;
    if (unsure) setJobStep(rt, old, { detail: unsure });
    rt.ledger.jobUpdate(old, { kept: true });
    // Its CLI is gone, so nothing would tell the agent: its next turn hears it’s still running, and why it ran on. Claude
    // Code, resumed, marks a background command it has no end for as stopped, and says so to the agent (#249).
    // A step that follows it reads as running on (#129): the agent leaves it running, rather than closing it as failed.
    rt.tellAgent(
      se.id,
      `Your background job ${id} (\`${clipText(old.command, 200)}\`) is still running: ${turn.stopReason === 'send-now' ? 'a message sent with Send now ended your last turn, but not this job' : 'the person stopped your last turn and kept this job running'}. If your CLI says it was stopped, that’s only because the process that started it has ended: it wasn’t stopped.${unsure ? ` ${unsure}` : ''}${old.outputFile ? ` Its output is in ${old.outputFile}.` : ''} They can stop it from the conversation. If a progress step follows it, leave that step running while the job runs: when it ends, Postbox tells you on your next turn.`,
    );
    rt.watchKept();
    return;
  }
  if (typeof j.state === 'string' && j.state !== 'running') {
    const lost = turn.keepJobs.has(id) && !old.kept;
    endJob(rt, se.id, id, old.stopping || lost ? 'stopped' : j.state, lost ? KEEP_LOST : null);
  }
}

/**
 * A job ended: it leaves the session’s list, and its step shows how.
 * @param {any} rt  the runtime
 * @param {string} sessionId @param {string} jobId @param {string} state @param {string|null} [detail]
 * @param {{ by?: 'you' | null }} [opts]
 */
export function endJob(rt, sessionId, jobId, state, detail = null, { by = null } = {}) {
  // Pending, so a job ended or kept behind a held commit is seen (#957).
  const se = rt.store.pending.session(sessionId);
  const job = se?.jobs?.find((j) => j.id === jobId);
  if (!se || !job) return;
  // Work says how it ended too: its turn may have ended thinking it was still running (#164).
  rt.ledger.jobUpdate(job, { state, by });
  rt.updateSession(sessionId, (s) => ({ jobs: (s.jobs ?? []).filter((j) => j.id !== jobId) }));
  if (rt.keptPoll && !rt.keptJobs().length) {
    clearInterval(rt.keptPoll);
    rt.keptPoll = null;
  }
  // A kept job’s step loses what it said while running (keepUnsure); another’s keeps why its CLI said it failed.
  setJobStep(rt, job, { state: stepState(state), ms: Date.now() - job.startedAt, ...(detail || job.kept ? { detail } : {}) });
  // A job Postbox kept running ended after its CLI had gone, so the agent hears it on its next turn.
  if (job.kept)
    rt.tellAgent(
      sessionId,
      `Your background job ${job.id} (\`${clipText(job.command, 200)}\`) ${by === 'you' ? 'was stopped by the person' : 'has ended'}.${job.outputFile ? ` Its output is in ${job.outputFile}.` : ''}`,
    );
  // The last job kept running has ended: the progress steps held running with it (stop) stall now, as they would have
  // when its turn ended, or when the turn running now ends (stallSteps).
  const now = rt.store.pending.session(sessionId);
  const held = now?.heldSteps;
  if ((job.kept || detail === KEEP_LOST) && held && !(now.jobs ?? []).some((j) => j.kept)) {
    rt.updateSession(sessionId, { heldSteps: null });
    const problems = rt.turns.has(sessionId) ? [] : rt.stallSteps({ threadId: held.threadId }, rt.store.pending.session(sessionId));
    if (problems.length)
      rt.tellAgent(
        sessionId,
        `Your background job ${job.id} ended while progress steps were running:\n${problems.map((p) => `- Block “${p.scope.title ?? p.scope.id}” (id ${p.scope.id}): ${p.message}`).join('\n')}`,
      );
  }
}

/** The keys (`item:step`) of a session’s progress steps running in a thread. */
export function runningProgress(rt, threadId, sessionId) {
  return rt.store.pending
    .items(threadId)
    .filter((it) => it.kind === 'block' && it.valid && it.sessionId === sessionId && it.block.type === 'progress')
    .flatMap((it) => it.block.steps.filter((s) => s.state === 'running').map((s) => `${it.id}:${s.id}`));
}

/** Changes a job’s step: in its turn while that runs, else in the reply it’s on. */
export function setJobStep(rt, job, patch) {
  const live = rt.turns.get(job.sessionId);
  const turn = live?.id === job.turnId ? live : null;
  const steps = turn ? turn.steps : rt.store.pending.item(job.threadId, job.itemId)?.activity?.steps;
  if (!Array.isArray(steps)) return;
  const next = steps.map((st) => (st.id === job.toolUseId ? { ...st, ...patch } : st));
  if (turn) turn.steps = next;
  const step = job.itemId ? next.find((st) => st.id === job.toolUseId) : null;
  if (step) rt.store.emit('item.patch', { threadId: job.threadId, id: job.itemId, activityStep: step });
}

/** Jobs nothing reported the end of went with their CLI (SIGKILL, or a crash), unless Postbox kept them running. */
export function settleJobs(rt, turn) {
  for (const j of [...(rt.s.sessions[turn.sessionId]?.jobs ?? [])])
    if (j.turnId === turn.id && j.state === 'running' && !j.kept) endJob(rt, turn.sessionId, j.id, 'stopped', turn.keepJobs.has(j.id) ? KEEP_LOST : null);
  // Keep running kept none of them after all (KEEP_LOST): its reply doesn’t say they kept running (#249). One that was
  // kept counts though it’s been stopped since, from its row.
  if (turn.stopReason !== 'kept-jobs' || turn.keptAny || rt.s.sessions[turn.sessionId]?.jobs?.some((j) => j.turnId === turn.id && j.kept)) return;
  turn.stopReason = 'stop';
  for (const it of rt.store.pending.items(turn.threadId))
    if (it.turnId === turn.id && it.stopReason === 'kept-jobs') rt.patchItem(turn.threadId, it.id, { stopReason: 'stop' });
}

/** After a restart, no background job Postbox knew of is its to track any more. */
export function expireStaleJobs(rt) {
  for (const se of Object.values(rt.s.sessions))
    for (const j of se.jobs ?? [])
      endJob(rt, se.id, j.id, 'stopped', 'Postbox restarted while it ran. If Postbox didn’t shut down cleanly, it may still be running.');
}
