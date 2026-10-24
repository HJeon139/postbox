// Apps (#54, #38, #49): what an agent shows, the browser’s pre-display check of it, what an app sends in your voice,
// and its saved state and the host data it asks for; the files an agent names for it are in server/agent-files.mjs.
// Each is a Runtime method’s body, with the instance first; Runtime keeps a one-line method that calls it.

import { followsConversation, validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { notYours } from './app-retire.mjs';
import { httpError } from './helpers.mjs';

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */

/** App check problems that are warnings: the app is shown, with notes, and the agent is told. */
const APP_WARNINGS = new Set(['marks-too-small', 'text-too-small', 'dashes-too-fine', 'only-error']);

// ── Apps ───────────────────────────────────────────────────────────────────────────

/** The browser reports its pre-display check. The first failure goes back to the agent to fix. */
export function appCheck(rt, appId, { version, problems = [] }) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  // A retired app shows no frame, so a check still running when it was retired has nothing to fix (#193).
  if (version !== app.current || app.retired) return { ignored: true };
  const clean = (Array.isArray(problems) ? problems : [])
    .slice(0, 20)
    .map((p) => ({ code: String(p?.code).slice(0, 40), message: String(p?.message).slice(0, 300) }));
  if (!clean.length) {
    rt.store.emit('app', { ...app, check: { status: 'passed', attempt: app.check.attempt, problems: [] } });
    return { status: 'passed' };
  }
  if (clean.some((p) => p.code === 'script-error')) {
    rt.store.emit('app', { ...app, check: { status: 'crashed', attempt: app.check.attempt, problems: clean } });
    return { status: 'crashed' };
  }
  // Problems the agent can’t fix (the frame never answered, or a check of Postbox’s threw) are shown as a note, not
  // sent back. Warnings (marks or text too small, an app showing only an error) don’t hold the app back: it’s shown
  // with notes, and the agent hears of them through the lint pipeline, unless it’s already fixing the app.
  const fixable = clean.filter((p) => p.code !== 'no-answer' && p.code !== 'check-error');
  const blocking = fixable.filter((p) => !APP_WARNINGS.has(p.code));
  if (app.check.attempt === 0 && blocking.length && rt.s.sessions[app.sessionId]) {
    rt.store.emit('app', { ...app, check: { status: 'fixing', attempt: 1, problems: fixable } });
    rt.deliver(app.sessionId, { kind: 'app-check', appId, problems: fixable }, { threadId: app.threadId });
    return { status: 'fixing' };
  }
  const notes = clean.every((p) => APP_WARNINGS.has(p.code));
  rt.store.emit('app', { ...app, check: { status: 'note', attempt: app.check.attempt, problems: clean, ...(notes ? { notes } : {}) } });
  if (notes) {
    // The version was made by the agent’s turn that’s running, or else the last one that ended.
    const turnId = [...rt.turns.values()].find((t) => t.sessionId === app.sessionId)?.id ?? rt.lastTurn.get(app.sessionId);
    const scope = { kind: 'app', id: appId, title: app.title };
    rt.lint(
      app.sessionId,
      turnId,
      clean.map((p) => ({ ...p, scope })),
    );
  }
  return { status: 'note' };
}

// An app writes lines in your voice, and each one starts an agent turn, so its sends are limited (#38). The
// browser accepts a send only right after a click or key press in that app (app/js/apps.mjs); here, where a
// script calling the API lands too, an app gets APP_SEND_LIMIT sends per APP_SEND_WINDOW_MS. More wait on
// a card for you to allow or not, and nothing is dropped silently: the app is told its send is waiting.
// The browser keeps the same limit (SEND_LIMIT in app/js/app-send-card.mjs), and the agent guide says so.
export const APP_SEND_LIMIT = 5;
export const APP_SEND_WINDOW_MS = 60_000;
/** Sends one card holds; past that, a send is refused with a reason. */
export const APP_HOLD_MAX = 20;

/**
 * An event an app sends in your voice. Within the limit, it goes to the agent; past it (or when the browser
 * asks, with hold), it waits on the app’s card. The card and its events are items, so they survive a restart.
 * @param {any} rt  the Runtime @param {string} appId @param {string} action @param {object} values
 * @param {{ hold?: boolean, now?: number }} [opts]
 */
export function appEvent(rt, appId, action, values, { hold = false, now = Date.now() } = {}) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  if (app.retired) throw httpError(409, `${app.title} was retired, so it can’t send messages.`);
  const r = buildEvent({ type: 'app', id: appId, title: app.title }, action, values);
  if (!r.ok) throw httpError(422, r.error);
  const items = rt.store.items(app.threadId);
  const card = items.find((x) => x.kind === 'appsend' && x.appId === appId && x.status === 'open');
  // Sends you allowed on a card don’t count against the next minute.
  const recent = items.filter((x) => x.kind === 'voice' && x.appId === appId && !x.approved && now - (x.sentAt ?? x.at) < APP_SEND_WINDOW_MS).length;
  // Once some sends wait, later ones wait behind them, so the agent gets them in order.
  if (card || hold || recent >= APP_SEND_LIMIT) {
    const held = { action: r.event.action, values: r.event.values, voice: r.voice, sent: r.event.sent, ...(r.quote ? { quote: r.quote } : {}) };
    const waiting = (card?.events.length ?? 0) + 1;
    if (card) {
      if (card.events.length >= APP_HOLD_MAX)
        throw httpError(429, `${card.events.length} messages from ${app.title} are already waiting for the person to allow them. Wait for their answer.`);
      rt.patchItem(app.threadId, card.id, { events: [...card.events, held] });
    }
    const cardId =
      card?.id ?? rt.addItem(app.threadId, { kind: 'appsend', appId, title: app.title, sessionId: app.sessionId, events: [held], status: 'open' }).id;
    rt.needAppSend(app, cardId, waiting);
    return {
      ok: true,
      held: true,
      waiting,
      message: `Held for the person to allow: an app sends up to ${APP_SEND_LIMIT} messages a minute. ${waiting === 1 ? '1 message is' : `${waiting} messages are`} waiting.`,
    };
  }
  rt.addItem(app.threadId, { kind: 'voice', text: r.voice, ...(r.quote ? { quote: r.quote } : {}), appId, sentAt: now });
  if (rt.s.sessions[app.sessionId]) rt.deliver(app.sessionId, { kind: 'event', event: r.event }, { threadId: app.threadId });
  return { ok: true, voice: r.voice };
}

/** An open app card makes its agent need you and tells you, like a permission card, unless it already needs you. */
export function needAppSend(rt, app, itemId, waiting) {
  const se = rt.s.sessions[app.sessionId];
  if (!se || (se.needs && se.needs.itemId !== itemId)) return;
  const text = `${app.title} wants to send ${waiting === 1 ? '1 message' : `${waiting} messages`} for you`;
  rt.updateSession(se.id, { needs: { kind: 'appsend', itemId, text }, state: rt.turns.has(se.id) ? se.state : 'needs' });
  if (waiting === 1) rt.notify('blocking', se, text, `Apps send up to ${APP_SEND_LIMIT} a minute in your voice. Allow these, or don’t.`);
}

/** Your answer on an app’s card: allow sends the waiting events as they were sent; don’t allow drops them. */
export function resolveAppSend(rt, threadId, itemId, action, { now = Date.now() } = {}) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'appsend' || it.status !== 'open') throw httpError(409, 'That request was already answered.');
  if (action !== 'allow' && action !== 'deny') throw httpError(400, 'An app’s request takes “allow” or “deny”.');
  const allow = action === 'allow';
  rt.patchItem(threadId, itemId, { status: allow ? 'allowed' : 'declined', answeredAt: now });
  const owner = rt.s.sessions[it.sessionId];
  if (owner?.needs?.itemId === itemId) rt.updateSession(owner.id, { needs: null, state: rt.turns.has(owner.id) ? owner.state : 'idle' });
  if (!allow) {
    const n = it.events.length;
    rt.addItem(threadId, { kind: 'voice', text: `Didn’t allow ${it.title} to send ${n === 1 ? '1 message' : `${n} messages`}` });
    return { ok: true };
  }
  const se = rt.s.sessions[it.sessionId];
  for (const ev of it.events) {
    rt.addItem(threadId, { kind: 'voice', text: ev.voice, ...(ev.quote ? { quote: ev.quote } : {}), appId: it.appId, sentAt: now, approved: true });
    const event = {
      blockId: it.appId,
      action: ev.action,
      values: ev.values,
      ...(ev.sent ? { sent: ev.sent } : {}),
      ...(ev.quote ? { appSummary: ev.quote } : {}),
    };
    if (se && !se.archived) rt.deliver(se.id, { kind: 'event', event }, { threadId });
  }
  return { ok: true };
}

export function appState(rt, appId, state) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const json = JSON.stringify(state ?? null);
  if (json.length > 256 * 1024) throw httpError(413, 'Saved app state is limited to 256 KB.');
  // An app that saves the same state again (on every load, say) changes nothing.
  if (json === JSON.stringify(app.state ?? null)) return;
  rt.store.emit('app', { ...app, state: JSON.parse(json) });
}

/** An app asks the host for data. It can use only tools both it and its agent were granted. */
export function appQuery(rt, appId, tool, args) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const se = rt.s.sessions[app.sessionId];
  const persona = se && rt.personaFor(se);
  const allowed = new Set((app.versions[app.current - 1].permissions ?? []).filter((t) => persona?.tools?.includes(t)));
  if (!allowed.has(tool)) throw httpError(403, `This app can’t use “${tool}”. It needs the permission, and its agent needs the tool.`);
  return hostTool(rt, tool, args);
}

/**
 * A data file of an app’s version (#54), as the app reads it with postbox.file(name).
 * @param {any} rt  the Runtime @param {string} appId @param {string} name @param {number} [v]  the version; the current one by default
 */
export async function appFile(rt, appId, name, v) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const ver = app.versions[(Number(v) || app.current) - 1];
  const f = ver?.files?.find((x) => x.name === name);
  if (!f || !rt.blobs) throw httpError(404, `This version of ${app.title} has no file “${name}”.`);
  return rt.blobs.get(f.sha256);
}

/** @param {any} rt  the Runtime @param {string} sessionId @param {any} block @param {string} itemId @param {string} [threadId] @param {AppFile[]} [files] */
export function registerApp(rt, sessionId, block, itemId, threadId = rt.s.sessions[sessionId]?.threadId, files = []) {
  rt.store.emit('app', {
    id: block.id,
    threadId,
    sessionId,
    itemId,
    title: block.title ?? 'App',
    versions: [{ v: 1, code: block.code, permissions: block.permissions ?? [], files, at: Date.now(), summary: '' }],
    current: 1,
    state: null,
    check: { status: 'pending', attempt: 0, problems: [] },
  });
}

/**
 * @param {any} rt  the Runtime @param {string} sessionId @param {any} turn  the turn the tools act for, or null
 * @param {() => string} threadId  where the turn speaks @param {() => void} endSegment  ends the reply so far
 * @param {{ id: string, code: string, permissions?: string[], title?: string, summary?: string }} args
 * @param {{ files?: AppFile[] }} [given]  as for show_app; a version without them keeps the last one’s
 */
export function updateApp(rt, sessionId, turn, threadId, endSegment, { id, code, permissions, title, summary = '' }, given = {}) {
  const app = rt.s.apps[id];
  if (!app || app.sessionId !== sessionId) return notYours(rt, sessionId, id);
  const v = validateBlock({ id, type: 'app', version: 1, fallback: 'x', code, permissions: permissions ?? app.versions[app.current - 1].permissions });
  if (!v.ok) return { ok: false, message: `The update was invalid: ${v.errors.join(' ')}` };
  const versions = [
    ...app.versions,
    {
      v: app.versions.length + 1,
      code,
      permissions: v.block.permissions ?? [],
      files: given.files ?? app.versions[app.current - 1].files ?? [],
      summary: String(summary ?? '').slice(0, 300),
      at: Date.now(),
    },
  ];
  // A new version brings a retired app back (#193).
  const { retired: _, ...live } = app;
  const next = {
    ...live,
    title: typeof title === 'string' && title.trim() ? title.slice(0, 200) : app.title,
    versions,
    current: versions.length,
    check: { status: 'pending', attempt: app.check.attempt },
  };
  rt.store.emit('app', next);
  // A new version always comes to the newest point, where the agent says what changed (#49).
  let moved = false;
  if (followsConversation({ type: 'app' })) {
    if (app.threadId === threadId()) endSegment();
    moved = rt.bringForward(app.threadId, app.itemId, { what: 'app', title: next.title, v: versions.length }, turn ? { turnId: turn.id } : {});
  }
  return { ok: true, message: `App ${id} is now v${versions.length}${moved ? ', shown at the newest point in the conversation' : ''}.` };
}

/** Host tools that apps (through the bridge) and agents can use, if granted. */
export function hostTool(rt, tool, args = {}) {
  switch (tool) {
    case 'corpus.search': {
      const q = String(args.query ?? '').slice(0, 200);
      const mode = ['both', 'lexical', 'semantic'].includes(args.mode) ? args.mode : 'both';
      return rt.corpus.search(q, { mode, k: Math.min(50, +args.k || 12), books: Array.isArray(args.books) ? args.books : undefined });
    }
    case 'corpus.read':
      return rt.corpus.read(String(args.id ?? ''));
    case 'corpus.stats':
      return rt.corpus.stats();
    case 'narrate.speak':
      if (!rt.narrator) throw httpError(503, 'Narration isn’t installed here. Run npm install to add Kokoro, then restart Postbox.');
      return rt.narrator.speak(args);
    default:
      throw httpError(404, `There’s no host tool called “${tool}”.`);
  }
}
