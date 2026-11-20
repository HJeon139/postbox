// What the conversation shows of an agent’s run clock (server/run-clock.mjs): a line at each change of it, so the
// person sees its state where they work, and why an agent with an expired or paused clock doesn’t answer. A system
// line with its text, which the page shows as it is (app/js/system-line.mjs); no turn reads it as a message.

/** @param {number} ms */
const s = (ms) => `${Math.floor(ms / 1000)}s`;

/** Each change’s words. @type {Record<string, (h: string, d: any) => string>} */
const WORDS = {
  started: (h, d) => `@${h}’s run clock started, with a budget of ${s(d.budgetMs)}.`,
  paused: (h, d) =>
    d.stopping?.length
      ? `@${h}’s run clock is paused. Postbox asked @${h}’s host to stop it, and starts no turn of it until the clock resumes. Until the host confirms the stop, @${h} may still be working there, so the clock counts on.`
      : `@${h}’s run clock is paused. Postbox stopped @${h}, and starts no turn of it until the clock resumes.`,
  resumed: (h, d) => `@${h}’s run clock resumed at ${s(d.elapsedMs)} of ${s(d.budgetMs)}.`,
  expired: (h, d) =>
    `@${h}’s run clock reached its budget of ${s(d.budgetMs)}, so Postbox ${d.stopping?.length ? `asked @${h}’s host to stop @${h}, which may still be working there until the host confirms` : `stopped @${h}`}. Messages to @${h} here now wait, and no turn starts; a new timed run goes in a new conversation.`,
  stopped: (h, d) =>
    `@${h}’s host confirmed its turn stopped, at ${s(d.elapsedMs)} of @${h}’s run clock.${!d.left && d.state === 'paused' ? ' The paused clock stops counting here.' : ''}`,
  restored: (h, d) =>
    `Postbox started again with @${h}’s run clock at ${s(d.elapsedMs)} of ${s(d.budgetMs)}. The time it was down counted, and @${h} may have worked through it on its host.`,
};

/**
 * A line in the agent’s conversation for a change of its clock.
 * @param {any} rt @param {string} sessionId @param {keyof typeof WORDS} change @param {{ budgetMs: number, elapsedMs?: number, stopping?: string[], state?: string, left?: number }} d
 */
export function clockNote(rt, sessionId, change, d) {
  const se = rt.store.pending.session(sessionId) ?? rt.s.sessions[sessionId];
  if (!se) return;
  rt.threads.addItem(se.threadId, { kind: 'system', variant: 'clock', sessionId, handle: se.handle, change, text: WORDS[change](se.handle, d) });
}

/** The line a clock’s state needs last in its conversation, for a state that holds the agent. */
const HOLDING = /** @type {const} */ ({ paused: 'paused', expired: 'expired' });

/**
 * As Postbox starts, a clock that holds its agent gets its line if the conversation lacks it: the clock’s event and
 * its line are two writes, and a kill between them would leave the agent held with nothing to say so (hydrant-critic’s
 * review of #1522). The line is the newest clock line for that session, so a second start adds nothing.
 * @param {any} rt @param {string} sessionId @param {any} clock
 */
export function repairClockNote(rt, sessionId, clock) {
  const change = Object.hasOwn(HOLDING, clock?.state) ? HOLDING[/** @type {'paused' | 'expired'} */ (clock.state)] : null;
  const se = rt.store.pending.session(sessionId) ?? rt.s.sessions[sessionId];
  if (!change || !se) return;
  const last = rt.store.pending
    .items(se.threadId)
    .findLast((/** @type {any} */ i) => i.kind === 'system' && i.variant === 'clock' && i.sessionId === sessionId);
  if (last?.change !== change) clockNote(rt, sessionId, change, { budgetMs: clock.budgetMs, elapsedMs: clock.usedMs, stopping: clock.stopping ?? [] });
}
