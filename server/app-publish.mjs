// What an app shares with its agent, and the agent reads (#1478): postbox.publish keeps the app’s current data on the
// app, and its agent hears at its next turn that it changed, through a notice, which never starts a turn. read_app is
// the agent’s tool for it, and for the app’s saved state. No card, no line in the person’s voice, nobody needs them.

import { conversationOf } from '../shared/room-refs.mjs';
import { httpError } from './helpers.mjs';

/** The most an app may publish, as JSON: the same as its saved state. */
const PUBLISH_BYTES = 256 * 1024;

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

/**
 * postbox.publish(data): the app’s data for its agent, replacing what it published before.
 * @param {any} rt @param {string} appId @param {unknown} data
 */
export function publishApp(rt, appId, data) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  if (app.retired) throw httpError(409, `${app.title} was retired, so it can’t publish.`);
  const json = JSON.stringify(data ?? null);
  if (json.length > PUBLISH_BYTES) throw httpError(413, 'What an app publishes is limited to 256 KB as JSON.');
  if (json === JSON.stringify(app.published ?? null)) return { ok: true, unchanged: true };
  rt.store.emit('app', { ...app, published: JSON.parse(json), publishedAt: Date.now() });
  noticeOnce(rt, app, 'has new data from the person');
  return { ok: true };
}

/**
 * read_app { appId }: what an app in the agent’s conversation published, and its saved state.
 * @param {any} rt @param {string} sessionId @param {{ appId?: unknown }} [args]
 */
export function readApp(rt, sessionId, { appId } = {}) {
  const se = rt.session(sessionId);
  const id = String(appId ?? '').slice(0, 80);
  const app = rt.s.apps[id];
  if (!app || conversationOf(rt.s.threads, app.threadId) !== conversationOf(rt.s.threads, se.threadId))
    return { ok: false, message: `There’s no app “${id}” in your conversation. Use the appId show_app returned.` };
  const out = {
    appId: id,
    title: app.title,
    version: app.current,
    published: app.published ?? null,
    publishedAt: app.publishedAt ? new Date(app.publishedAt).toISOString() : null,
    savedState: app.state ?? null,
  };
  return { ok: true, message: JSON.stringify(out) };
}
