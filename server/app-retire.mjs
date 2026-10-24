// Retiring an app (#193): an app its agent no longer needs shows as one line in its place, saying why and leading to
// what replaced it, with its version menu (app/js/apps.mjs). It stays where it is, since nothing new needs the person,
// and it runs no sandbox until they open a version. A new version (update_app) brings it back.

/**
 * Why there’s no app of the session’s with that id. With no forks (#228), a topic thread’s agent is the conversation’s
 * own session, so there’s no longer an app it showed under another session (#216).
 * @param {any} _rt  the Runtime @param {string} _sessionId @param {string} id
 */
export function notYours(_rt, _sessionId, id) {
  return { ok: false, message: `There’s no app with id ${id} from you.` };
}

/**
 * retire_app { id, reason, replacedBy? }: only the agent that showed the app retires it, and replacedBy is an app or a
 * block shown in the same conversation, the caller’s own when another agent’s block has the same id.
 * @param {any} rt  the Runtime @param {string} sessionId @param {{ id?: unknown, reason?: unknown, replacedBy?: unknown }} args
 */
export function retireApp(rt, sessionId, { id, reason, replacedBy } = {}) {
  const app = rt.s.apps[String(id)];
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
    const other = rid === app.id ? null : rt.s.apps[rid];
    const shown = rt.store.items(app.threadId).filter((x) => x.kind === 'block' && x.valid && x.block.id === rid && (other || x.block.type !== 'app'));
    const item = shown.find((x) => x.sessionId === sessionId) ?? shown[0];
    if (!item) return { ok: false, message: `There’s no other app or block ${rid} in this conversation. Name one shown here, or leave out replacedBy.` };
    to = { id: rid, title: String(other?.title ?? item.block.title ?? item.block.prompt ?? rid).slice(0, 200), itemId: item.id };
  }
  rt.store.emit('app', { ...app, retired: { by: rt.session(sessionId).handle, reason: why, replacedBy: to, at: Date.now() } });
  release(rt, app);
  return { ok: true, message: `Retired ${app.title}. It shows as one line where it was, with its versions; update_app brings it back.` };
}

/**
 * A retired app can’t act: sends waiting on its card for the person to allow are dropped, with the card saying why, and
 * its agent no longer needs the person for them. Later sends are refused (appEvent in server/apps.mjs).
 */
function release(rt, app) {
  const card = rt.store.items(app.threadId).find((x) => x.kind === 'appsend' && x.appId === app.id && x.status === 'open');
  if (!card) return;
  rt.patchItem(app.threadId, card.id, { status: 'declined', retired: true, answeredAt: Date.now() });
  const se = rt.s.sessions[card.sessionId];
  if (se?.needs?.itemId === card.id) rt.updateSession(se.id, { needs: null, state: rt.turns.has(se.id) ? se.state : 'idle' });
}
