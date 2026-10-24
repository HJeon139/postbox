// A stopped turn’s process has exited (#126): the session takes what waited for it. Moved from server/runtime.mjs; the
// function takes the Runtime first (architecture.md, “What a move may change”).

import { newId } from './store.mjs';

/**
 * A turn’s adapter is done, which for a real backend means its process has exited. Its background jobs that nothing
 * reported the end of went with it, and a stopped session takes what waited for it: the messages sent meanwhile,
 * then the queue.
 */
export function turnExited(rt, turn) {
  rt.settleJobs(turn);
  const ex = rt.exiting.get(turn.sessionId);
  if (ex?.turn !== turn) return;
  rt.exiting.delete(turn.sessionId);
  const se = rt.s.sessions[turn.sessionId];
  if (!se) return;
  // Something else may have set the state meanwhile (archive, an answered card); “Stopping” goes either way.
  if (se.state === 'stopping' || se.currentStep === 'Stopping')
    rt.updateSession(se.id, { state: se.state === 'stopping' ? 'idle' : se.state, currentStep: 'Stopped by you', finishedAt: Date.now(), sideTurn: null });
  else if (se.sideTurn) rt.updateSession(se.id, { sideTurn: null });
  const held = se.archived || se.deleting ? [] : ex.held;
  // A summary that waited and won’t start now isn’t coming (#93).
  if (held !== ex.held) for (const h of ex.held) if (h.summarizeTo) rt.clearSummaryPending(h.threadId);
  // Shutting down: your messages wait in their thread’s queue, which a restart keeps, rather than starting a CLI.
  if (rt.closing) {
    for (const h of held.filter((x) => x.message.kind === 'user')) {
      const t = rt.s.threads[h.threadId ?? se.threadId];
      const q = { id: newId('q'), text: h.message.text ?? '', attachments: h.message.attachments ?? [], sessionIds: [se.id], at: Date.now() };
      if (t) rt.putThread({ ...t, queue: [...(t.queue ?? []), q] });
    }
    return;
  }
  for (const h of held) rt.deliver(se.id, h.message, { replyTo: h.replyTo, summarizeTo: h.summarizeTo, threadId: h.threadId });
  if (!held.length && !ex.silent) rt.drainQueues(se.id, turn.threadId);
}
