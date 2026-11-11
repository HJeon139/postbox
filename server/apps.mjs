// Apps (#54, #38, #49): what an agent shows, the browser’s pre-display check of it, what an app sends in your voice,
// and its saved state and the host data it asks for; the files an agent names for it are in server/agent-files.mjs.
// Each is a Runtime method’s body, with the instance first; Runtime keeps a one-line method that calls it.

import { followsConversation, validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { INTENT_CHARS, LIMITS } from '../shared/limits.mjs';
import { wordCount } from '../shared/text.mjs';
import { appReceipt } from './app-check-status.mjs';
import { notYours } from './app-retire.mjs';
import { APP_HOLD_MAX, APP_SEND_LIMIT, APP_SEND_WINDOW_MS } from './app-send-limits.mjs';
import { offerNeed, releaseNeed } from './card-needs.mjs';
import { httpError, refuseArchived } from './helpers.mjs';
import { HELD_BY_EVERY_AGENT, hostTool } from './host-tool.mjs';
import { newId } from './store.mjs';

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */

/**
 * App check problems that are warnings: the app is shown, with notes, and the agent is told. Text under 12 px holds a
 * version back at 1000 × 680, as the critique’s floor does (#997): agents shipped the labels this flagged when it was a
 * warning. At 375 px it stays a warning: an SVG scaled to fit a narrow pane draws its labels small.
 */
const APP_WARNINGS = new Set(['marks-too-small', 'text-too-small-375', 'dashes-too-fine', 'only-error']);

/**
 * What a version should leave the reader with, as the agent said it (#995), or '' when it said nothing: a missing or
 * malformed intent never refuses an app, and a very long one is cut for storage.
 */
const intentOf = (v) => (typeof v === 'string' ? v.trim().slice(0, INTENT_CHARS) : '');

/**
 * The receipt’s note on an intent past its word limit, or ''. It’s flagged, not refused: the app is the work, and the
 * agent can say it shorter with update_app. @param {unknown} v
 */
function intentNote(v) {
  const n = typeof v === 'string' ? wordCount(v) : 0; // before the storage cut, so a very long one reports its length
  return n > LIMITS.appIntentWords ? ` Its intent has ${n} words: say it in at most ${LIMITS.appIntentWords} with update_app.` : '';
}

/**
 * An app block as show_block takes it, with its intent trimmed and cut as show_app’s is, or dropped when it isn’t
 * text, so the catalog never refuses an app for its intent. @param {any} block
 */
export function withAppIntent(block) {
  if (block?.type !== 'app' || !Object.hasOwn(block, 'intent')) return block;
  const { intent, ...rest } = block;
  return intentOf(intent) ? { ...rest, intent: intentOf(intent) } : rest;
}

/** A receipt with the intent’s note, when there is one. @param {any} r @param {unknown} intent */
export const withIntentNote = (r, intent) => (r.ok && intentNote(intent) ? { ...r, message: r.message + intentNote(intent) } : r);

// ── Apps ───────────────────────────────────────────────────────────────────────────

/** The browser reports its pre-display check. The first failure goes back to the agent to fix. */
export function appCheck(rt, appId, { version, problems = [] }) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  // A retired app shows no frame, so a check still running when it was retired has nothing to fix (#193).
  if (version !== app.current || app.retired || app.check.status !== 'pending') return { ignored: true };
  const clean = (Array.isArray(problems) ? problems : [])
    .slice(0, 20)
    .map((p) => ({ code: String(p?.code).slice(0, 40), message: String(p?.message).slice(0, 300) }));
  if (!clean.length) {
    rt.store.emit('app', { ...app, check: { status: 'passed', attempt: app.check.attempt, problems: [] } });
    return { status: 'passed' };
  }
  // A script error goes back to the agent once, like any blocking problem (#964); after that, or with no agent to
  // tell, the version shows as crashed.
  if (clean.some((p) => p.code === 'script-error') && (app.check.attempt > 0 || !rt.s.sessions[app.sessionId])) {
    rt.store.emit('app', { ...app, check: { status: 'crashed', attempt: app.check.attempt, problems: clean } });
    return { status: 'crashed' };
  }
  // Problems the agent can’t fix (the frame never answered, or a check of Postbox’s threw) are shown as a note, not
  // sent back. Warnings (marks or dashes too small, an app showing only an error) don’t hold the app back: it’s shown
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
    const turnId = [...rt.turns.values()].find((t) => t.sessionId === app.sessionId)?.id ?? rt.s.sessions[app.sessionId]?.lastTurnId;
    const scope = { kind: 'app', id: appId, title: app.title };
    rt.lint(
      app.sessionId,
      turnId,
      clean.map((p) => ({ ...p, scope })),
    );
  }
  return { status: 'note' };
}

/** The status of an app whose agent’s app-check turn ended without a new version: crashed if its script threw (#964). */
export const fixEnded = (app) => (app.check.problems?.some((p) => p.code === 'script-error') ? 'crashed' : 'note');

// An app’s sends are limited (#38): server/app-send-limits.mjs says how, and why.

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
  refuseArchived(rt, app.sessionId);
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

/**
 * An open app card makes its agent need you and tells you, like a permission card, unless it already needs you. It
 * waits until you answer it: the agent’s turns, and you moving on (#69), leave it (runtime.mjs keeps it, as a hop).
 */
export function needAppSend(rt, app, itemId, waiting) {
  const se = rt.s.sessions[app.sessionId];
  if (!se) return;
  // A later event of a card that isn't the need changes nothing: the card isn't new, so it doesn't offer itself again.
  if (waiting !== 1 && se.needs?.itemId !== itemId) return;
  const text = `${app.title} wants to send ${waiting === 1 ? '1 message' : `${waiting} messages`} for you`;
  const took = offerNeed(rt, se, { kind: 'appsend', itemId, text, ...rt.awayFrom(se, app.threadId) }, rt.turns.has(se.id) ? se.state : 'needs');
  // Only the first event is noticed: behind another need it isn't yet, and is when it becomes the need (card-needs.mjs).
  if (waiting !== 1) return;
  rt.patchItem(app.threadId, itemId, { notifiedAt: took ? Date.now() : null });
  if (took) rt.notify('blocking', se, text, `Apps send up to ${APP_SEND_LIMIT} a minute in your voice. Allow these, or don’t.`);
}

/** Your answer on an app’s card: allow sends the waiting events as they were sent; don’t allow drops them. */
export function resolveAppSend(rt, threadId, itemId, action, { now = Date.now() } = {}) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'appsend' || it.status !== 'open') throw httpError(409, 'That request was already answered.');
  if (action !== 'allow' && action !== 'deny') throw httpError(400, 'An app’s request takes “allow” or “deny”.');
  const allow = action === 'allow';
  if (allow) refuseArchived(rt, it.sessionId);
  rt.patchItem(threadId, itemId, { status: allow ? 'allowed' : 'declined', answeredAt: now });
  const owner = rt.s.sessions[it.sessionId];
  releaseNeed(rt, owner, itemId);
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

/**
 * An app asks the host for data. It can use only tools both it and its agent were granted; every agent holds its
 * conversation’s assets (HELD_BY_EVERY_AGENT), so an app reads them by naming them in its permissions.
 */
export function appQuery(rt, appId, tool, args) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const se = rt.s.sessions[app.sessionId];
  const persona = se && rt.personaFor(se);
  const held = (/** @type {string} */ t) => HELD_BY_EVERY_AGENT.has(t) || persona?.tools?.includes(t);
  const allowed = new Set((app.versions[app.current - 1].permissions ?? []).filter(held));
  if (!allowed.has(tool)) throw httpError(403, `This app can’t use “${tool}”. It needs the permission, and its agent needs the tool.`);
  return hostTool(rt, tool, args, { threadId: app.threadId });
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
    versions: [{ v: 1, code: block.code, permissions: block.permissions ?? [], files, at: Date.now(), summary: '', intent: intentOf(block.intent) }],
    current: 1,
    state: null,
    check: { status: 'pending', attempt: 0, problems: [] },
  });
}

/** The app an item shows, when it's the app's own item, not a stub left where it was. @param {any} rt @param {any} it */
export function appOf(rt, it) {
  const app = it?.kind === 'block' && it.valid && it.block?.type === 'app' ? rt.s.apps[it.block.id] : null;
  return app?.itemId === it.id ? app : null;
}

/**
 * show_app: an app is a block of type app (showBlock, server/block-show.mjs), and an id the session already holds is a
 * new version (updateApp). @param {import('./runtime.mjs').Runtime} rt @param {string} sessionId
 * @param {any} tools  the turn's tools as toolsFor made them
 * @param {{ id?: string, title?: string, code: string, permissions?: string[], fallback?: string, intent?: string }} args
 * @param {{ files?: AppFile[] }} [given]  data files Postbox read from the agent’s folders (#54); never from the call
 */
export function showApp(rt, sessionId, tools, { id, title, code, permissions = [], fallback, intent }, given = {}) {
  const blockId = id ?? newId('app');
  const existing = rt.store.pending.app(blockId);
  if (existing?.sessionId === sessionId) return tools.update_app({ id: blockId, code, permissions, title, intent }, given);
  return tools.show_block(
    {
      block: {
        id: blockId,
        type: 'app',
        version: 1,
        title: title ?? 'App',
        fallback: fallback ?? `${title ?? 'An app'}: open Postbox to use it.`,
        code,
        permissions,
        // As the agent said it: show_block trims it, cuts it and flags a long one, for every way an app is shown.
        ...(intent !== undefined && { intent }),
      },
    },
    given,
  );
}

/**
 * @param {any} rt  the Runtime @param {string} sessionId @param {any} turn  the turn the tools act for, or null
 * @param {() => string} threadId  where the turn speaks @param {() => void} endSegment  ends the reply so far
 * @param {{ id: string, code: string, permissions?: string[], title?: string, summary?: string, intent?: string }} args
 * @param {{ files?: AppFile[] }} [given]  as for show_app; a version without them keeps the last one’s, as one without an intent does
 */
export function updateApp(rt, sessionId, turn, threadId, endSegment, { id, code, permissions, title, summary = '', intent }, given = {}) {
  const app = rt.store.pending.app(id);
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
      intent: intentOf(intent) || (app.versions[app.current - 1].intent ?? ''),
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
  return withIntentNote(appReceipt(next, `App ${id} is now v${versions.length}${moved ? ', shown at the newest point in the conversation' : ''}.`), intent);
}
