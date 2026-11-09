// Helpers that the runtime and the modules moved out of it share (architecture.md, “What a move may change”).

import { timingSafeEqual } from 'node:crypto';
import { SENDING } from '../shared/limits.mjs';
import { toPlainText } from '../shared/markdown.mjs';

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, userMessage: message });
}
/**
 * The first n UTF-16 units of s, or one fewer when the last would be the first half of a surrogate pair: a cut there
 * would leave a lone surrogate, which shows as nothing or a box (#1052). @param {string} s @param {number} n
 */
const head = (s, n) => {
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
};
export const clipText = (s, n) => (s.length > n ? `${head(s, n - 1)}…` : s);
export const clip = (s, n = 200) => {
  const t = toPlainText(s);
  return t.length > n ? head(t, n - 1) + '…' : t;
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
 * @param {string} what  how the refusal names it @param {string} text
 */
export function tooLongToSend(what, text) {
  if (text.length <= SENDING.message) return null;
  const n = (k) => k.toLocaleString('en-US');
  return { ok: false, message: `${what} is up to ${n(SENDING.message)} characters, and this one has ${n(text.length)}, so nothing was sent. Send less.` };
}
/** A message waiting in a conversation’s queue, or a 404: an edit, a removal or a Send now of one that isn’t there does nothing (#352). */
export function queuedIn(t, queueId) {
  const q = (t.queue ?? []).find((x) => x.id === queueId);
  if (!q) throw httpError(404, 'That queued message was already sent or removed.');
  return q;
}
