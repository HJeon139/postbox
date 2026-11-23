// An agent’s app that keeps animating with no input from the person (#438). The app page’s kit reports a run of frames
// that has lasted 30 seconds on its own (app/kit/frames.js), and the app’s agent hears it at its next turn, once per
// version: the version told is kept on the app, so a restart doesn’t tell it again. The person sees nothing: only the
// agent can fix its app, so nothing waits on them (AGENTS.md, “Scope”).

import { httpError } from './helpers.mjs';

/**
 * The page’s report that an app’s current version keeps animating. An unknown app is refused; a report for an older
 * version, a retired app or one already told is dropped, and so is one while Postbox can’t save.
 * @param {any} rt @param {string} appId @param {unknown} version
 */
export function appAnimating(rt, appId, version) {
  // As written, held commits included: what it finds decides a write. Own keys only: “constructor” is no app (#352).
  const apps = rt.store.pending.apps();
  const app = Object.hasOwn(apps, appId) ? apps[appId] : null;
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const se = rt.s.sessions[app.sessionId];
  if (app.retired || version !== app.current || app.animatingTold === version || !se || !rt.store.writable) return { ok: true, told: false };
  rt.store.emit('app', { ...app, animatingTold: version });
  rt.sessions.tell(
    se.id,
    `Your app “${app.title}” v${version} kept animating for 30 seconds with no input from the person, drawing every frame. If nothing on it needs to keep moving, make its loop stop on its own: when its state stops changing, at a time limit, or after a set number of steps. Either way, keep any history a fixed size, and don’t rebuild a whole chart from it every frame.`,
  );
  return { ok: true, told: true };
}
