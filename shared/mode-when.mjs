// When a permission mode change applies, in the quick panel’s words (#371, #381). UI text only: no agent reads it, so it
// sits apart from shared/agent-facts.mjs, which agents’ guides read.

/**
 * When a permission mode change applies, as the quick panel of one session says it (#371, #381): now, where the backend
 * changed its running turn; else from the next turns, with a note for each running turn that keeps the old mode: this
 * conversation’s, which Stop beside the note applies now, and those in other conversations, by count.
 * @param {{ now: string[], later?: string[] }} r  session ids  @param {string} sessionId  the panel’s session
 */
export function modeWhen(r, sessionId) {
  if (r.now.includes(sessionId)) return 'from now: its running turn changed too.';
  const later = r.later ?? [];
  const here = later.includes(sessionId) ? ' Its running turn here keeps the mode it started with until it ends: Stop it to apply this now.' : '';
  const n = later.filter((id) => id !== sessionId).length;
  const elsewhere = !n
    ? ''
    : n === 1
      ? ' Its running turn in another conversation keeps the mode it started with until it ends.'
      : ` Its ${n} running turns in other conversations keep the mode they started with until they end.`;
  return `from their next turns.${here}${elsewhere}`;
}
