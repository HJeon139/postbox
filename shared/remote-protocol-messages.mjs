// Checking, building and parsing one message on a channel (shared/remote-protocol.mjs). A refused message is the
// sender’s bug when it builds one, and an error to report and skip when it reads one.

import { HOST_CHANNELS } from './remote-protocol-channels-host.mjs';
import { POSTBOX_CHANNELS } from './remote-protocol-channels-postbox.mjs';
import { clip, isObj, run, utf8Bytes } from './remote-protocol-checks.mjs';
import { REMOTE_LIMITS } from './remote-protocol-constants.mjs';

/**
 * The channels, named sender-to-receiver. Each maps a message type to its validator, which returns an error to show
 * or ''. Field types are in each validator.
 */
const CHANNELS = { ...POSTBOX_CHANNELS, ...HOST_CHANNELS };

/** @typedef {keyof typeof CHANNELS} Channel */
/** @template T @typedef {import('./remote-protocol-checks.mjs').Result<T>} Result */

/** The channel names. */
export const CHANNEL_NAMES = /** @type {Channel[]} */ (Object.keys(CHANNELS));

/** The message types each channel carries. @param {Channel} channel */
export const messageTypes = (channel) => Object.keys(CHANNELS[channel]);

/**
 * Checks one decoded message for a channel.
 * @param {Channel} channel @param {unknown} value
 * @returns {Result<{ type: string, [field: string]: any }>}
 */
export function validateMessage(channel, value) {
  const types = CHANNELS[channel];
  if (!types) return { ok: false, error: `There’s no channel “${clip(channel)}”.` };
  if (!isObj(value)) return { ok: false, error: 'A message must be a JSON object.' };
  const type = /** @type {any} */ (value).type;
  if (typeof type !== 'string' || !Object.hasOwn(types, type))
    return { ok: false, error: `“${clip(type)}” isn’t a message on this channel; it carries ${Object.keys(types).join(', ')}.` };
  return run(type, value, () => types[type](value));
}

/**
 * One validator per message: VALIDATORS[channel][type](value).
 * @type {Record<Channel, Record<string, (value: unknown) => Result<{ type: string, [field: string]: any }>>>}
 */
export const VALIDATORS = /** @type {any} */ (
  Object.fromEntries(
    CHANNEL_NAMES.map((c) => [
      c,
      Object.fromEntries(
        Object.keys(CHANNELS[c]).map((t) => [
          t,
          (v) =>
            isObj(v) && /** @type {any} */ (v).type === t ? validateMessage(c, v) : { ok: false, error: `A ${t} message must be an object with type “${t}”.` },
        ]),
      ),
    ]),
  )
);

/**
 * Builds a message to send, and throws if it isn’t valid: a refused message is the sender’s bug.
 * @param {Channel} channel @param {string} type @param {Record<string, unknown>} [body]
 */
export function message(channel, type, body = {}) {
  const r = validateMessage(channel, { type, ...body });
  if (!r.ok) throw new TypeError(r.error);
  return r.msg;
}

/** A message as one line, with its \n. Throws if it’s over REMOTE_LIMITS.lineBytes. @param {object} msg */
export function encode(msg) {
  const s = JSON.stringify(msg);
  if (utf8Bytes(s) > REMOTE_LIMITS.lineBytes) throw new RangeError(`A ${/** @type {any} */ (msg).type} message is over ${REMOTE_LIMITS.lineBytes} bytes.`);
  return `${s}\n`;
}

/** A message’s encoded size without its \n, to decide whether a line must be sent cut. @param {object} msg */
export const encodedBytes = (msg) => utf8Bytes(JSON.stringify(msg));

/**
 * Parses and validates one line of text (without its \n).
 * @param {Channel} channel @param {string} text
 * @returns {Result<{ type: string, [field: string]: any }> & { code?: 'bad-json' | 'bad-message' }}
 */
export function parseLine(channel, text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'bad-json', error: `A line wasn’t JSON (${e.message}).` };
  }
  const r = validateMessage(channel, v);
  return r.ok ? r : { ...r, code: 'bad-message' };
}
