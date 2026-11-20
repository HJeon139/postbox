// What the conversation shows of an agent’s run clock (server/run-clock.mjs): a line at each change of it, so the
// person sees its state where they work, and why an agent with an expired or paused clock doesn’t answer. A system
// line with its text, which the page shows as it is (app/js/system-line.mjs); no turn reads it as a message.

/** @param {number} ms */
const s = (ms) => `${Math.floor(ms / 1000)}s`;

/** Each change’s words. @type {Record<string, (h: string, d: any) => string>} */
const WORDS = {
  started: (h, d) => `@${h}’s run clock started, with a budget of ${s(d.budgetMs)}.`,
  paused: (h) => `@${h}’s run clock is paused. Postbox stopped @${h}, and starts no turn of it until the clock resumes.`,
  resumed: (h, d) => `@${h}’s run clock resumed at ${s(d.elapsedMs)} of ${s(d.budgetMs)}.`,
  expired: (h, d) =>
    `@${h}’s run clock reached its budget of ${s(d.budgetMs)}, so Postbox stopped @${h}. Messages to @${h} here now wait, and no turn starts; a new timed run goes in a new conversation.`,
  restored: (h, d) =>
    `Postbox started again with @${h}’s run clock at ${s(d.elapsedMs)} of ${s(d.budgetMs)}. The time it was down counted, and @${h} may have worked through it on its host.`,
};

/**
 * A line in the agent’s conversation for a change of its clock.
 * @param {any} rt @param {string} sessionId @param {keyof typeof WORDS} change @param {{ budgetMs: number, elapsedMs?: number }} d
 */
export function clockNote(rt, sessionId, change, d) {
  const se = rt.store.pending.session(sessionId) ?? rt.s.sessions[sessionId];
  if (!se) return;
  rt.threads.addItem(se.threadId, { kind: 'system', variant: 'clock', sessionId, handle: se.handle, change, text: WORDS[change](se.handle, d) });
}
