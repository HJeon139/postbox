// The notice an app’s agent hears at its next turn when the app has something new for it to read with read_app (#1478).
// Moved out of server/app-publish.mjs, so what an app publishes and the notes it sends both reach their agent this way.

/**
 * Tells the app’s agent, at its next turn, that the app has something new for it, unless a notice from this app is
 * already waiting: a burst of changes is one notice. @param {any} rt @param {any} app @param {string} what
 */
export function noticeOnce(rt, app, what) {
  const se = rt.s.sessions[app.sessionId];
  if (!se || se.retiredFork) return;
  const tag = `[app ${app.id}]`;
  if (rt.delivery.waiting(se.id).some((/** @type {any} */ e) => e.source === 'notice' && e.text?.startsWith(tag))) return;
  rt.delivery.send(
    {
      sessionId: se.id,
      threadId: app.threadId,
      source: 'notice',
      text: `${tag} ${app.title} ${what} since you last looked. Call read_app with appId “${app.id}” to see it.`,
    },
    { wake: false },
  );
}
