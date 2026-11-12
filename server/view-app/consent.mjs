// The person’s answer about view_app’s browser (designs/architecture.md, “Agents see their app”): asked on a card, the
// first time an agent calls view_app. The answer is kept in Postbox’s data folder, so a restart keeps it, and a yes
// starts the download. “Not now” lasts a week: the next call after that asks again, so the person can change it. The card works like ask_for_tool’s (server/tool-ask.mjs): the person answers in the
// conversation, and the agent that asked hears the outcome as a notice.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Shows the card, once per conversation while it’s open. Returns what view_app tells the agent.
 * @param {any} rt @param {string} sessionId @param {string} threadId @param {() => void} endSegment
 */
export function askToSee(rt, sessionId, threadId, endSegment) {
  const se = rt.session(sessionId);
  const open = rt.store.pending.items(threadId).find((x) => x.kind === 'viewask' && x.status === 'open');
  if (!open) {
    endSegment();
    rt.addItem(threadId, { kind: 'viewask', sessionId, handle: se.handle, turnId: rt.turns.get(sessionId)?.id ?? null, status: 'open' });
  }
  return {
    ok: true,
    waiting: true,
    message:
      'Postbox asked the person whether to download the browser that renders your app. End your turn: their answer arrives as a message, and if they allow it, call view_app again then.',
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
  rt.patchItem(threadId, it.id, { status: 'downloading', answeredAt: Date.now() });
  view.browser.install().then((r) => {
    if (r.ok) settle(rt, threadId, it, 'ready', 'The person allowed the download, and it finished. Call view_app now to see your app.');
    // Postbox is stopping: the card says so, and no agent is woken on the way out.
    else if (r.message === STOPPED) settle(rt, threadId, it, 'failed', null, r.message);
    else settle(rt, threadId, it, 'failed', `The person allowed the download, but it failed: ${r.message} Carry on without view_app.`, r.message);
  });
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
      rt.patchItem(threadId, it.id, { status: 'failed', reason: STOPPED, settledAt: Date.now() });
      const se = rt.s.sessions[it.sessionId];
      if (se) releaseNeed(rt, se, it.id);
    }
  }
}

/**
 * The card’s last state, and the agent that asked hears it.
 * @param {any} rt @param {string} threadId @param {any} it @param {string} status @param {string|null} notice  null tells no one
 * @param {string|null} [reason]
 */
function settle(rt, threadId, it, status, notice, reason = null) {
  rt.patchItem(threadId, it.id, { status, ...(reason ? { reason: String(reason).slice(0, 400) } : {}), settledAt: Date.now() });
  const se = rt.s.sessions[it.sessionId];
  if (!se) return { ok: true };
  releaseNeed(rt, se, it.id);
  if (notice && !se.retiredFork) rt.deliver(se.id, { kind: 'notice', text: notice });
  return { ok: true };
}
