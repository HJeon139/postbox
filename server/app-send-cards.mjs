// An app’s sends that wait for the person (#38): the card that holds what an app sends past its limit, the need it
// makes, the person’s answer on it, and the card dropped when its app is retired (#193). These are asks’, which wait
// for rooms at scale (designs/architecture/services.md, “What waits for rooms at scale”). Moved out of
// server/apps.mjs and server/app-retire.mjs.

import { APP_HOLD_MAX, APP_SEND_LIMIT } from './app-send-limits.mjs';
import { offerNeed, releaseNeed } from './card-needs.mjs';
import { httpError, refuseRetired } from './helpers.mjs';

/**
 * An app’s event held on its card (#38): past the limit, behind sends already waiting, or when the browser asks. The
 * card and its events are items, so they survive a restart, and its agent needs you until you answer it.
 * @param {any} rt  the Runtime @param {any} app @param {any} card  the app’s open card, if it has one @param {any} r  the event, from buildEvent
 */
export function holdAppSend(rt, app, card, r) {
  const held = { action: r.event.action, values: r.event.values, voice: r.voice, sent: r.event.sent, ...(r.quote ? { quote: r.quote } : {}) };
  const waiting = (card?.events.length ?? 0) + 1;
  if (card) {
    if (card.events.length >= APP_HOLD_MAX)
      throw httpError(429, `${card.events.length} messages from ${app.title} are already waiting for the person to allow them. Wait for their answer.`);
    rt.threads.patchItem(app.threadId, card.id, { events: [...card.events, held] });
  }
  const cardId =
    card?.id ??
    rt.threads.addItem(app.threadId, { kind: 'appsend', appId: app.id, title: app.title, sessionId: app.sessionId, events: [held], status: 'open' }).id;
  needAppSend(rt, app, cardId, waiting);
  return {
    ok: true,
    held: true,
    waiting,
    message: `Held for the person to allow: an app sends up to ${APP_SEND_LIMIT} messages a minute. ${waiting === 1 ? '1 message is' : `${waiting} messages are`} waiting.`,
  };
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
  const took = offerNeed(rt, se, { kind: 'appsend', itemId, text, ...rt.sessions.awayFrom(se, app.threadId) }, rt.turns.has(se.id) ? se.state : 'needs');
  // Only the first event is noticed: behind another need it isn't yet, and is when it becomes the need (card-needs.mjs).
  if (waiting !== 1) return;
  rt.threads.patchItem(app.threadId, itemId, { notifiedAt: took ? Date.now() : null });
  if (took) rt.threads.notify('blocking', se, text, `Apps send up to ${APP_SEND_LIMIT} a minute in your voice. Allow these, or don’t.`);
}

/** Your answer on an app’s card: allow sends the waiting events as they were sent; don’t allow drops them. */
export function resolveAppSend(rt, threadId, itemId, action, { now = Date.now() } = {}) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'appsend' || it.status !== 'open') throw httpError(409, 'That request was already answered.');
  if (action !== 'allow' && action !== 'deny') throw httpError(400, 'An app’s request takes “allow” or “deny”.');
  const allow = action === 'allow';
  if (allow) refuseRetired(rt.s.sessions[it.sessionId]);
  rt.threads.patchItem(threadId, itemId, { status: allow ? 'allowed' : 'declined', answeredAt: now });
  const owner = rt.s.sessions[it.sessionId];
  releaseNeed(rt, owner, itemId);
  if (!allow) {
    const n = it.events.length;
    rt.threads.addItem(threadId, { kind: 'voice', text: `Didn’t allow ${it.title} to send ${n === 1 ? '1 message' : `${n} messages`}` });
    return { ok: true };
  }
  const se = rt.s.sessions[it.sessionId];
  for (const ev of it.events) {
    rt.threads.addItem(threadId, { kind: 'voice', text: ev.voice, ...(ev.quote ? { quote: ev.quote } : {}), appId: it.appId, sentAt: now, approved: true });
    const event = {
      blockId: it.appId,
      action: ev.action,
      values: ev.values,
      ...(ev.sent ? { sent: ev.sent } : {}),
      ...(ev.quote ? { appSummary: ev.quote } : {}),
    };
    if (se && !se.retiredFork) rt.deliver(se.id, { kind: 'event', event }, { threadId });
  }
  return { ok: true };
}

/**
 * A retired app can’t act: sends waiting on its card for the person to allow are dropped, with the card saying why, and
 * its agent no longer needs the person for them. Later sends are refused (appEvent in server/apps.mjs).
 */
export function releaseRetired(rt, app) {
  const card = rt.store.pending.items(app.threadId).find((x) => x.kind === 'appsend' && x.appId === app.id && x.status === 'open');
  if (!card) return;
  rt.threads.patchItem(app.threadId, card.id, { status: 'declined', retired: true, answeredAt: Date.now() });
  const se = rt.s.sessions[card.sessionId];
  releaseNeed(rt, se, card.id);
}
