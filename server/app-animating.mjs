// An agent’s app that keeps animating with no input from the person (#438). The app page’s kit reports a loop that has
// drawn for 30 seconds on its own (app/kit/frames.js), and the app’s agent hears it at its next turn, once per version.
// The person sees nothing: only the agent can fix its app, so nothing waits on them (AGENTS.md, “Scope”).

import { httpError } from './helpers.mjs';

/** The versions whose agent has heard, as `appId@version`: once each while Postbox runs. */
const told = new Set();

/**
 * The page’s report that an app’s current version keeps animating. An unknown app is refused; a report for an older
 * version, a retired app or one already told is dropped. @param {any} rt @param {string} appId @param {unknown} version
 */
export function appAnimating(rt, appId, version) {
  // Own keys only: “constructor” or “__proto__” is a name every object inherits, not an app (#352).
  const app = Object.hasOwn(rt.store.state.apps, appId) ? rt.store.state.apps[appId] : null;
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  if (app.retired || version !== app.current) return { ok: true, told: false };
  const key = `${appId}@${version}`;
  const se = rt.s.sessions[app.sessionId];
  if (told.has(key) || !se) return { ok: true, told: false };
  told.add(key);
  rt.sessions.tell(
    se.id,
    `Your app “${app.title}” v${version} kept animating for 30 seconds with no input from the person, drawing every frame. Make its loop stop on its own: when its state stops changing, at a time limit, or after a set number of steps. Keep any history a fixed size, and don’t rebuild a whole chart from it every frame.`,
  );
  return { ok: true, told: true };
}
