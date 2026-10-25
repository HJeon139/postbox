// Helpers that the runtime and the modules moved out of it share (architecture.md, “What a move may change”).

import { timingSafeEqual } from 'node:crypto';
import { SENDING } from '../shared/limits.mjs';
import { toPlainText } from '../shared/markdown.mjs';

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, userMessage: message });
}
export const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const clip = (s, n = 200) => {
  const t = toPlainText(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
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
