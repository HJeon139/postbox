// The person’s answer about view_app’s browser (designs/architecture/view-app.md, “Agents see their app”): asked on a card, the
// first time an agent calls view_app. The answer is kept in Postbox’s data folder, so a restart keeps it, and a yes
// starts the download. “Not now” lasts a week: the next call after that asks again, so the person can change it. The card works like ask_for_tool’s (server/tool-ask.mjs): the person answers in the
// conversation, and the agent that asked hears the outcome as a notice.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cutText } from '../../shared/text-parts.mjs';
import { askAgain } from '../ask-again.mjs';
import { releaseNeed } from '../card-needs.mjs';
import { httpError } from '../helpers.mjs';
import { STOPPED } from './browser.mjs';
import { viewOf } from './view-of.mjs';

/** @typedef {'unasked'|'allowed'|'declined'} Answer */

/** How long “Not now” stands before view_app asks again. */
export const DECLINE_MS = 7 * 24 * 60 * 60 * 1000;

/** The answer kept in `dir`; a “Not now” older than a week counts as no answer. @param {string} dir @returns {Answer} */
export function answerIn(dir, now = Date.now()) {
  try {
    const { answer, at } = JSON.parse(readFileSync(join(dir, 'consent.json'), 'utf8'));
    if (answer === 'allowed') return 'allowed';
    return answer === 'declined' && now - Number(at) < DECLINE_MS ? 'declined' : 'unasked';
  } catch {
    // No file yet, or one that can’t be read: the person hasn’t answered, so they’re asked.
    return 'unasked';
  }
}

/** Keeps the answer, written atomically. @param {string} dir @param {'allowed'|'declined'} answer */
export function keepAnswer(dir, answer) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'consent.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ answer, at: Date.now() }), { mode: 0o600 });
  renameSync(tmp, file);
}

/** A view card still waiting on its answer or its download, which an agent that calls view_app is told about. */
const LIVE = new Set(['open', 'downloading']);

/** Each Runtime’s one live view card, kept as it’s shown: `{ threadId, itemId }`. @type {WeakMap<object, { threadId: string, itemId: string }>} */
const shown = new WeakMap();

/**
 * The one view card that’s open or downloading, in whichever thread it is (#1927): the answer and the download are
 * Postbox’s, not a thread’s, so there’s one at a time. Kept as it’s shown; found by a scan of the threads only when
 * none is kept (after a restart), which is a call that would show a card anyway.
 * @param {any} rt @returns {{ threadId: string, it: any } | null}
 */
function liveCard(rt) {
  const at = shown.get(rt);
  const kept = at ? rt.store.pending.item(at.threadId, at.itemId) : null;
  if (at && kept?.kind === 'viewask' && LIVE.has(kept.status)) return { threadId: at.threadId, it: kept };
  shown.delete(rt);
  for (const threadId of Object.keys(rt.s.threads)) {
    const it = rt.store.pending.items(threadId).find((x) => x.kind === 'viewask' && LIVE.has(x.status));
    if (it) {
      shown.set(rt, { threadId, itemId: it.id });
      return { threadId, it };
    }
  }
  return null;
}

/**
 * Notes an agent on the card, once, so it hears how the card ends (settle): any agent but the one that asked, which
 * hears it anyway. @param {any} rt @param {{ threadId: string, it: any }} card @param {string} sessionId
 */
function noteWaiting(rt, { threadId, it }, sessionId) {
  if (it.sessionId === sessionId || (it.waiting ?? []).includes(sessionId)) return;
  rt.threads.patchItem(threadId, it.id, { waiting: [...(it.waiting ?? []), sessionId] });
}

/**
 * Shows the card, once while it’s open or downloading, wherever the agent’s turn runs. Returns what view_app tells
 * the agent: to carry on without the picture, since the answer reaches it as a message and nothing needs it to stop
 * (#1927; #1975, no agent waits behind another).
 * @param {any} rt @param {string} sessionId @param {string} threadId @param {() => void} endSegment
 */
export function askToSee(rt, sessionId, threadId, endSegment) {
  const se = rt.session(sessionId);
  const card = liveCard(rt);
  // Offered again only to the agent that asked, while it’s open. Any other agent’s call finds it and gets no need of
  // its own: the card notes it, and it hears the answer (#1927).
  if (card?.it.status === 'open' && card.it.sessionId === sessionId) askAgain(rt, se, card.it, card.threadId);
  else if (card) noteWaiting(rt, card, sessionId);
  else {
    endSegment();
    const it = rt.threads.addItem(threadId, { kind: 'viewask', sessionId, handle: se.handle, turnId: rt.turns.get(sessionId)?.id ?? null, status: 'open' });
    shown.set(rt, { threadId, itemId: it.id });
    // It is the agent’s need from now, while the turn runs on, as an asking block just shown is (#1868, card-needs.mjs offerShown).
    rt.bus.emit('block.asking', { se, item: it, threadId });
  }
  return {
    ok: true,
    waiting: true,
    message:
      'Postbox asked the person whether to download the browser that renders your app. Carry on without the picture for now: their answer arrives as a message, and if they allow it, call view_app again then.',
  };
}

/**
 * An agent that calls view_app while the download the person allowed runs (#1927): the downloading card notes it,
 * wherever it is, so it hears when the browser is ready, and it carries on meanwhile. Returns what view_app tells it.
 * @param {any} rt @param {string} sessionId
 */
export function waitForDownload(rt, sessionId) {
  const card = liveCard(rt);
  if (card) noteWaiting(rt, card, sessionId);
  return {
    ok: true,
    waiting: true,
    message: 'The browser is still downloading. Carry on without the picture for now; you’ll hear when it’s ready, and can call view_app then.',
  };
}

/**
 * The person’s answer on the card: download or decline. A download runs in the background; the card says how it went,
 * and the agent hears it either way.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {string} action
 */
export function resolveViewAsk(rt, threadId, itemId, action) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'viewask' || it.status !== 'open') throw httpError(409, 'That was already answered.');
  if (action !== 'download' && action !== 'decline') throw httpError(400, 'This card takes “download” or “decline”.');
  const view = viewOf(rt);
  if (action === 'decline') {
    keepAnswer(view.dir, 'declined');
    return settle(rt, threadId, it, 'declined', 'The person chose not to download the browser, so view_app can’t show you your app. Carry on without it.');
  }
  keepAnswer(view.dir, 'allowed');
  rt.threads.patchItem(threadId, it.id, { status: 'downloading', answeredAt: Date.now() });
  // The person has answered, so the agent no longer needs them while the download runs (#954); it hears how it ends.
  const se = rt.s.sessions[it.sessionId];
  if (se) releaseNeed(rt, se, it.id);
  view.browser
    .install()
    .then((r) => {
      if (r.ok) settle(rt, threadId, it, 'ready', 'The person allowed the download, and it finished. Call view_app now to see your app.');
      // Postbox is stopping: the card says so, and no agent is woken on the way out.
      else if (r.message === STOPPED) settle(rt, threadId, it, 'failed', null, r.message);
      else settle(rt, threadId, it, 'failed', `The person allowed the download, but it failed: ${r.message} Carry on without view_app.`, r.message);
    })
    .catch((e) => console.error(`Postbox couldn’t tell the agents waiting on the browser download how it ended: ${e.message}`));
  return { ok: true };
}

/**
 * At startup, a card still downloading is one a stopped or killed Postbox cut short: it says so, and its need is
 * released. The agent’s turn is long over, so it isn’t told; its next call asks again. O(items), once per start.
 * @param {any} rt
 */
export function settleDownloads(rt) {
  for (const threadId of Object.keys(rt.s.threads)) {
    for (const it of rt.store.items(threadId)) {
      if (it.kind !== 'viewask' || it.status !== 'downloading') continue;
      rt.threads.patchItem(threadId, it.id, { status: 'failed', reason: STOPPED, settledAt: Date.now() });
      const se = rt.s.sessions[it.sessionId];
      if (se) releaseNeed(rt, se, it.id);
    }
  }
}

/**
 * The card’s last state, and each agent told to wait for it hears it: the agent that asked, and any other whose call
 * found the card open (#1927). Only the agent that asked had a need to release.
 * @param {any} rt @param {string} threadId @param {any} it @param {string} status @param {string|null} notice  null tells no one
 * @param {string|null} [reason]
 */
function settle(rt, threadId, it, status, notice, reason = null) {
  rt.threads.patchItem(threadId, it.id, { status, ...(reason ? { reason: cutText(String(reason), 400) } : {}), settledAt: Date.now() });
  const asker = rt.s.sessions[it.sessionId];
  if (asker) releaseNeed(rt, asker, it.id);
  // Read now, not as the person answered: an agent can join while the download runs (waitForDownload).
  const waiting = rt.store.pending.item(threadId, it.id)?.waiting ?? [];
  for (const id of new Set([it.sessionId, ...waiting])) {
    // Read as delivery reads it, so a session it would refuse (deleted or retired) is skipped, not thrown on.
    const se = rt.store.pending.session(id);
    // The person’s answer, or how the download it allowed ended, is an entry pointing at the card (designs/rooms-at-scale.md,
    // “What an entry is”), with the words its turn is given until Turns builds input from entries.
    if (se && notice && !se.retiredFork)
      rt.delivery.send({ sessionId: se.id, threadId: se.threadId, source: 'answer', itemId: it.id, from: 'you', message: { kind: 'notice', text: notice } });
  }
  return { ok: true };
}
