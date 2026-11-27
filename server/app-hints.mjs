// Findings of an app’s check that only its agent hears (#952): with no other finding, the version passes, and the person
// sees no note. Moved from server/apps.mjs.

/**
 * Of the warnings, those only the agent hears: alone, they leave the version passed, with no note for the person. Labels
 * on a chart’s marks (#952) are one: in a sample of real apps, half of what it flagged was a legible touch, which isn’t
 * worth the person’s attention, and the person chose that the agent alone hears it.
 */
export const APP_HINTS = new Set(['text-over-marks']);

/**
 * A version that passed, or whose only findings are hints for the agent alone: those go to it through the lint pipeline
 * of the turn that made the version, and stay on the check for it to read; the person sees the version as passed.
 * @param {any} apps @param {any} app  the app as checked() read it @param {number} version @param {any[]} hints
 */
export function passed(apps, app, version, hints) {
  if (hints.length) {
    const turnId = apps.running.turnOf(app.sessionId)?.id ?? apps.store.state.sessions[app.sessionId]?.lastTurnId;
    const scope = { kind: 'app', id: app.id, title: app.title };
    apps.checks.lint(
      app.sessionId,
      turnId,
      hints.map((p) => ({ ...p, scope })),
    );
  }
  const check = { status: 'passed', attempt: app.check.attempt, problems: [], ...(hints.length ? { hints } : {}) };
  apps.store.emit('app', { ...app, lastShown: version, check });
  return { status: 'passed' };
}
