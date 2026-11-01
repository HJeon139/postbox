// The runtime owns archive passes and waits for them during shutdown (#305).
import { archiveTurns } from './work-archive.mjs';

/**
 * Runs the archive pass for a conversation after any run already queued for it (W4), so the turn-end pass and the
 * one-time pass after start never overlap. Resolves with how many turns it archived; never rejects (W2).
 * @param {any} rt
 * @param {string} convId
 */
export function archiveConversation(rt, convId) {
  // W5: shutting down, no new run starts; stopArchiving waits for the ones already queued.
  if (rt.archiveClosing) return Promise.resolve(0);
  const run = (rt.archiveChains.get(convId) ?? Promise.resolve(0)).then(() => rt.archiveOnce(convId));
  rt.archiveChains.set(convId, run);
  run.then(() => {
    if (rt.archiveChains.get(convId) === run) rt.archiveChains.delete(convId);
  });
  return run;
}
/** Settles when no archive run is queued for the conversation. @param {any} rt */
export function archiveIdle(rt, convId) {
  return rt.archiveChains.get(convId) ?? Promise.resolve(0);
}
/** After start: every conversation’s older turns, one conversation at a time, yielding between them. @param {any} rt */
export async function archiveAll(rt) {
  for (const t of Object.values(rt.s.threads))
    if (rt.archiveClosing) return;
    else if (!t.parentId && !t.deleting) {
      await rt.archiveConversation(t.id);
      await new Promise((r) => setImmediate(r));
    }
}
/**
 * W5: the runtime owns the archive chains, and they end before the Store does. No new run starts, and this resolves
 * when the queued ones have settled; index.mjs calls it after stopTurns and before store.close().
 * @param {any} rt
 */
export async function stopArchiving(rt, boundMs) {
  rt.archiveClosing = true;
  // Bounded, as every other shutdown step is: a disk that doesn't answer must not keep the Store open (critic). A
  // put that lands later leaves at most an orphan archive file, which draft 6 accepts (a re-put is idempotent).
  let timer;
  const late = new Promise((r) => {
    // Not unref'd: if nothing else keeps the loop alive while a pass hangs, an unref'd timer would let the process end
    // before store.close() runs (CI canceled the spec this way). It's cleared as soon as the passes settle.
    timer = setTimeout(() => r('late'), boundMs);
  });
  const result = await Promise.race([Promise.all([...rt.archiveChains.values()]), late]);
  clearTimeout(timer);
  if (result === 'late')
    console.warn(`An archive pass was still running after ${boundMs} ms; shutting down without it. It leaves at most an unused archive file.`);
}
/** Busy for the pass (I4): turns still running, and turns with a job kept running after a Stop. Read per turn. @param {any} rt */
export function archiveRunning(rt) {
  const running = new Set([...rt.turns.values()].map((t) => t.id));
  for (const se of Object.values(rt.s.sessions)) for (const j of se.jobs ?? []) if (j.kept && j.turnId) running.add(j.turnId);
  return running;
}
/** @param {any} rt */
export async function archiveOnce(rt, convId) {
  // W3: writable, not shutting down, and the conversation still there, checked before every file the run puts.
  const canWrite = () => rt.store.writable && !rt.archiveClosing && Boolean(rt.s.threads[convId]);
  if (!canWrite()) return 0;
  try {
    return await archiveTurns({ store: rt.store, blobs: rt.ledger.blobs, convId, running: () => rt.archiveRunning(), canWrite });
  } catch (e) {
    // Shutting down, or the store closed under the run: not a failure to report (as 1b’s snapshot rule).
    if (rt.archiveClosing || /** @type {any} */ (e)?.code === 'ECLOSED' || !rt.store.writable) return 0;
    // W2: one line, no retry loop; the next turn’s end tries again.
    console.warn(
      `Old turns in ${rt.s.threads[convId]?.title ?? convId} weren’t archived: ${e instanceof Error ? e.message : e}. The next turn’s end tries again.`,
    );
    return 0;
  }
}
