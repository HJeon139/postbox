// Helpers that the runtime and the modules moved out of it share (architecture.md, “What a move may change”).

import { timingSafeEqual } from 'node:crypto';
import { SENDING } from '../shared/limits.mjs';
import { toPlainText } from '../shared/markdown.mjs';
import { partEnd } from '../shared/text-parts.mjs';

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, userMessage: message });
}
/** s cut to n characters with an ellipsis, never inside a surrogate pair (partEnd, #1052). */
export const clipText = (s, n) => (s.length > n ? `${s.slice(0, partEnd(s, n - 1))}…` : s);
/** An id an agent sent, cut to 40 characters, for a refusal that names it: a reply never echoes one whole (#895). @param {unknown} id */
export const echoedId = (id) => {
  const s = String(id ?? '');
  return s.slice(0, partEnd(s, 40)); // never half of a pair (#1052)
};
export const clip = (s, n = 200) => {
  const t = toPlainText(s);
  return t.length > n ? t.slice(0, partEnd(t, n - 1)) + '…' : t;
};
/** Code in a fence longer than any run of backticks in it. */
export const fenced = (code, language = '') => {
  const ticks = '`'.repeat(Math.max(3, ...[...String(code).matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${language}\n${code}\n${ticks}`;
};
/** Whether a token sent matches the one wanted, compared in constant time (designs/developing.md, “Security”). */
export function sameToken(want, got) {
  const a = Buffer.from(String(want ?? ''));
  const b = Buffer.from(String(got ?? ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
/**
 * What an agent sends another agent or the conversation, refused past SENDING.message rather than cut, so it knows
 * nothing arrived (#351). Null when it’s within the limit.
 * @param {string} what  how the refusal names it @param {string} text @param {string} [next]  what to do instead
 */
export function tooLongToSend(what, text, next = 'Send less.') {
  if (text.length <= SENDING.message) return null;
  const n = (k) => k.toLocaleString('en-US');
  return { ok: false, message: `${what} is up to ${n(SENDING.message)} characters, and this one has ${n(text.length)}, so nothing was sent. ${next}` };
}
/** A message waiting in a conversation’s queue, or a 404: an edit, a removal or a Send now of one that isn’t there does nothing (#352). */
export function queuedIn(t, queueId) {
  const q = (t.queue ?? []).find((x) => x.id === queueId);
  if (!q) throw httpError(404, 'That queued message was already sent or removed.');
  return q;
}

/** The refusal of a fork #228 retired: no message reaches it, since its agent answers in the conversation now. @param {any} se */
export const retiredError = (se) => httpError(409, `@${se.handle}’s session here was retired. Write to @${se.handle} in the conversation.`);

/**
 * A retired fork can’t hear the person (deliver refuses it), so what they answer or send for it is refused before
 * anything is recorded (#848). @param {any} rt @param {string} sessionId
 */
export function refuseRetired(rt, sessionId) {
  const se = rt.s.sessions[sessionId];
  if (se?.retiredFork) throw retiredError(se);
}
