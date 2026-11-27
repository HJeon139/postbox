// Findings of an app’s check that only its agent hears (#952): with no other finding, the version passes, and the person
// sees no note. Moved from server/apps.mjs.

import { awaited } from './app-check-wait.mjs';

/**
 * Of the warnings, those only the agent hears: alone, they leave the version passed, with no note for the person. Labels
 * on a chart’s marks (#952) are one: in a sample of real apps, half of what it flagged was a legible touch, which isn’t
 * worth the person’s attention, and the person chose that the agent alone hears it.
 */
export const APP_HINTS = new Set(['text-over-marks']);
const isHint = (/** @type {any} */ p) => APP_HINTS.has(p?.code);
// Findings of a check that didn’t finish, which the agent can’t fix.
const unfinished = (/** @type {any} */ p) => p.code === 'no-answer' || p.code === 'check-error';

/**
 * A check’s findings with its hints last, so the report’s cap on findings never drops one that holds the version back
 * for a hint. @param {any[]} problems
 */
export const hintsLast = (problems) => [...problems.filter((p) => !isHint(p)), ...problems.filter(isHint)];

/**
 * What’s left for the person, and the hints the agent alone is told, kept on the check, when every other finding is one
 * the agent can’t fix: the person’s note is then about the check that didn’t finish, not the labels.
 * @param {any} apps @param {any} app @param {number} version @param {any[]} clean
 */
export function keepForAgent(apps, app, version, clean) {
  const rest = clean.filter((p) => !isHint(p));
  if (rest.length === clean.length || !rest.every(unfinished)) return { clean, kept: {} };
  const hints = clean.filter(isHint);
  tell(apps, app, version, hints);
  return { clean: rest, kept: { hints } };
}

/**
 * Tells the agent of hints through the lint pipeline of the turn that made the version, unless that turn’s reply is
 * waiting for this check: the reply names them (checkLine, server/app-check-wait.mjs), and a lint turn would repeat them.
 * @param {any} apps @param {any} app @param {number} version @param {any[]} hints
 */
function tell(apps, app, version, hints) {
  const live = apps.running.turnOf(app.sessionId);
  if (live && !live.abort?.signal?.aborted && awaited(apps, app.id, version, live)) return;
  const turnId = live?.id ?? apps.store.state.sessions[app.sessionId]?.lastTurnId;
  const scope = { kind: 'app', id: app.id, title: app.title };
  apps.checks.lint(
    app.sessionId,
    turnId,
    hints.map((p) => ({ ...p, scope })),
  );
}

/**
 * A version that passed, or whose only findings are hints for the agent alone: the agent is told of them (tell), and they
 * stay on the check for it to read; the person sees the version as passed.
 * @param {any} apps @param {any} app  the app as checked() read it @param {number} version @param {any[]} hints
 */
export function passed(apps, app, version, hints) {
  if (hints.length) tell(apps, app, version, hints);
  const check = { status: 'passed', attempt: app.check.attempt, problems: [], ...(hints.length ? { hints } : {}) };
  apps.store.emit('app', { ...app, lastShown: version, check });
  return { status: 'passed' };
}
