// The protocol’s checks on single values (shared/remote-protocol.mjs): IDs, numbers, text, lists and host paths.
// Each returns the error to show, or '' when the value is fine, so a message’s checks chain with ||.

import { ATTACHMENTS_DIR, REMOTE_DIR, REMOTE_LIMITS, TURN_FILES } from './remote-protocol-constants.mjs';
import { checkHostPath } from './remote-settings.mjs';

/** @template T @typedef {{ ok: true, msg: T } | { ok: false, error: string }} Result */

export const TURN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,35}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
export const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
export const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SIGNAL_RE = /^SIG[A-Z0-9]{2,10}$/;
export const LOGS = Object.freeze(['out', 'in']);
export const TURN_STATES = Object.freeze(['running', 'ended', 'interrupted']);
/** Names in a turn’s folder that start.files can’t take: its own files, and the folder attachments land in. */
export const RESERVED = new Set([...Object.values(TURN_FILES), ATTACHMENTS_DIR]);

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const clip = (v, n = 60) => {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** @template T @param {string} what @param {unknown} v @param {() => string} check @returns {Result<T>} */
export function run(what, v, check) {
  try {
    const error = check();
    return error ? { ok: false, error } : { ok: true, msg: /** @type {T} */ (v) };
  } catch (e) {
    // A check reads only shapes it has already confirmed, so this is a bug in this file; it still mustn’t escape.
    return { ok: false, error: `Couldn’t check the ${what} message: ${e.message}` };
  }
}

/** The object has every required field, and no field outside required, optional and `type`. */
export function fields(m, at, required, optional = []) {
  if (!isObj(m)) return `${at} must be an object.`;
  for (const k of Object.keys(m)) if (k !== 'type' && !required.includes(k) && !optional.includes(k)) return `“${clip(k)}” isn’t a field of ${at}.`;
  return has(m, at, required);
}

/** The object has every required field; it may have others. */
export function has(m, at, required) {
  for (const k of required) if (!Object.hasOwn(m, k) || m[k] === undefined) return `${at} needs “${k}”.`;
  return '';
}

export const opt = (v, check) => (v === undefined ? '' : check(v));
export const bool = (v, at) => (typeof v === 'boolean' ? '' : `${at} must be true or false.`);
export const obj = (v, at) => (isObj(v) ? '' : `${at} must be an object.`);
export const oneOf = (v, at, options) => (options.includes(v) ? '' : `${at} must be one of ${options.join(', ')}; got “${clip(v)}”.`);
export const turnId = (v, at) =>
  typeof v === 'string' && TURN_RE.test(v)
    ? ''
    : `${at} must be a turn ID: up to 36 letters, digits, - and _, starting with a letter or digit; got “${clip(v)}”.`;
export const id = (v, at) =>
  typeof v === 'string' && ID_RE.test(v)
    ? ''
    : `${at} must be an ID: up to 128 letters, digits and _ . : -, starting with a letter or digit; got “${clip(v)}”.`;
export const token = (v, at) =>
  typeof v === 'string' && TOKEN_RE.test(v) ? '' : `${at} must be the host’s token from ~/${REMOTE_DIR}/token: 32 to 128 letters, digits, - and _.`;

export function int(v, at, min, max) {
  if (!Number.isSafeInteger(v)) return `${at} must be a whole number; got “${clip(v)}”.`;
  return v < min || v > max ? `${at} must be from ${min} to ${max}; got ${v}.` : '';
}

/** A string of at most `max` characters (and at least `min`), with no NUL. */
export function str(v, at, max, min = 0) {
  if (typeof v !== 'string') return `${at} must be text.`;
  if (v.length < min) return `${at} can’t be empty.`;
  if (v.length > max) return `${at} is ${v.length} characters; the limit is ${max}.`;
  return v.includes('\0') ? `${at} can’t contain a NUL character.` : '';
}

export function list(v, at, max, each) {
  if (!Array.isArray(v)) return `${at} must be a list.`;
  if (v.length > max) return `${at} has ${v.length} entries; the limit is ${max}.`;
  for (let i = 0; i < v.length; i++) {
    const e = each(v[i], i);
    if (e) return e;
  }
  return '';
}

export function unique(values, at, what) {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) return `${at} names the ${what} “${clip(v)}” twice.`;
    seen.add(v);
  }
  return '';
}

/** A host path, by remote-settings.mjs’s one rule for them, so a saved setting is a path these messages carry. */
export function hostPath(v, at) {
  const r = checkHostPath(v, at);
  return r.ok ? '' : r.error;
}

/** UTF-8 bytes in a string, without encoding it. Lone surrogates count 3, as TextEncoder writes U+FFFD. @param {string} s */
export function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** A line of a log, without its \n, which it can’t contain. */
export function streamLine(v, at) {
  if (typeof v !== 'string') return `${at} must be text.`;
  if (v.includes('\n')) return `${at} is one line, so it can’t contain a newline.`;
  const n = utf8Bytes(v);
  return n > REMOTE_LIMITS.streamLineBytes ? `${at} is ${n} bytes; the limit is ${REMOTE_LIMITS.streamLineBytes}.` : '';
}

/** A line’s next is just past its \n, or at its end for a last line with none. */
export function lineSpan(offset, next, text) {
  const end = offset + utf8Bytes(text);
  return next === end + 1 || next === end ? '' : `line.next must be ${end + 1}, just past the line’s \\n (or ${end} for a last line with none); got ${next}.`;
}
