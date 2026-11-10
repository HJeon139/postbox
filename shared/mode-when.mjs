// When a permission mode change applies, in the quick panel’s words (#371, #381). UI text only: no agent reads it, so it
// sits apart from shared/agent-facts.mjs, which agents’ guides read. The permissions panel and /mode say the same
// reasons in their own sentences (app/js/permissions.mjs, app/js/run-choice.mjs).

/**
 * Why a running turn keeps its mode when its backend could change it: Postbox refuses a switch the hooks the turn
 * loaded, or Run everything, would outlast (switchesLive in shared/hook-modes.mjs, #806, #1030).
 */
export const KEPT_WHY = 'Postbox doesn’t tighten a running turn’s mode, since your hooks or Run everything could still approve a call there without your card.';

/** What a running turn that switched live from a mode without the person’s hooks still lacks (#806, #1030). */
export const HOOKS_LATER = 'though your hooks load only from its next turn';

/** How this conversation’s running turn keeps its mode: why, where Postbox keeps it. */
const keepsHere = (r, sessionId) =>
  r.kept?.includes(sessionId) ? `keeps its mode until it ends: ${KEPT_WHY}` : 'keeps the mode it started with until it ends:';

/**
 * When a permission mode change applies, as the quick panel of one session says it (#371, #381): now, where the backend
 * changed its running turn; else from the next turns, with a note for each running turn that keeps the old mode: this
 * conversation’s, which Stop beside the note applies now, and those in other conversations, by count.
 * This conversation’s says why where Postbox keeps it (kept), and a live switch says when the hooks it lacks load.
 * @param {{ now: string[], later?: string[], kept?: string[], hooksLater?: string[] }} r  session ids, as
 *   setPermissionMode answers  @param {string} sessionId  the panel’s session
 */
export function modeWhen(r, sessionId) {
  if (r.now.includes(sessionId)) return `from now: its running turn changed too${r.hooksLater?.includes(sessionId) ? `, ${HOOKS_LATER}` : ''}.`;
  const later = r.later ?? [];
  const here = later.includes(sessionId) ? ` Its running turn here ${keepsHere(r, sessionId)} Stop it to apply this now.` : '';
  const n = later.filter((id) => id !== sessionId).length;
  const elsewhere = !n
    ? ''
    : n === 1
      ? ' Its running turn in another conversation keeps the mode it started with until it ends.'
      : ` Its ${n} running turns in other conversations keep the mode they started with until they end.`;
  return `from their next turns.${here}${elsewhere}`;
}
