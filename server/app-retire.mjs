// Retiring an app (#193): an app its agent no longer needs shows as one line in its place, saying why and leading to
// what replaced it, with its version menu (app/js/apps.mjs). It stays where it is, since nothing new needs the person,
// and it runs no sandbox until they open a version. A new version (update_app) brings it back.

import { releaseRetired } from './app-send-cards.mjs';
import { echoedId } from './helpers.mjs';

/**
 * Why there’s no app of the session’s with that id. With no forks (#228), a topic thread’s agent is the conversation’s
 * own session, so there’s no longer an app it showed under another session (#216).
 * @param {any} _rt  the Runtime @param {string} _sessionId @param {string} id
 */
export function notYours(_rt, _sessionId, id) {
  return { ok: false, message: `There’s no app with id ${echoedId(id)} from you.` };
}

/**
 * retire_app { id, reason, replacedBy? }: only the agent that showed the app retires it, and replacedBy is an app or a
 * block shown in the same conversation, the caller’s own when another agent’s block has the same id.
 * @param {any} rt  the Runtime @param {string} sessionId @param {{ id?: unknown, reason?: unknown, replacedBy?: unknown }} args
 */
export function retireApp(rt, sessionId, { id, reason, replacedBy } = {}) {
  const app = rt.store.pending.app(String(id));
  if (!app || app.sessionId !== sessionId) return notYours(rt, sessionId, String(id));
  const why = String(reason ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (!why) return { ok: false, message: 'retire_app needs a reason, which the person reads in the app’s place.' };
  /** @type {{ id: string, title: string, itemId: string } | null} */
  let to = null;
  if (replacedBy != null && replacedBy !== '') {
    const rid = String(replacedBy);
    const other = rid === app.id ? null : rt.store.pending.app(rid);
    const shown = rt.store.pending.items(app.threadId).filter((x) => x.kind === 'block' && x.valid && x.block.id === rid && (other || x.block.type !== 'app'));
    const item = shown.find((x) => x.sessionId === sessionId) ?? shown[0];
    if (!item)
      return { ok: false, message: `There’s no other app or block ${echoedId(rid)} in this conversation. Name one shown here, or leave out replacedBy.` };
    to = { id: rid, title: String(other?.title ?? item.block.title ?? item.block.prompt ?? rid).slice(0, 200), itemId: item.id };
  }
  rt.store.emit('app', { ...app, retired: { by: rt.session(sessionId).handle, reason: why, replacedBy: to, at: Date.now() } });
  releaseRetired(rt, app);
  return { ok: true, message: `Retired ${app.title}. It shows as one line where it was, with its versions; update_app brings it back.` };
}
