// Framing (shared/remote-protocol.mjs): bytes split into lines on \n, then into a channel’s messages. Nothing here
// throws on bad input: a line it can’t read goes to onError, and reading goes on with the next.

import { REMOTE_LIMITS } from './remote-protocol-constants.mjs';
import { parseLine } from './remote-protocol-messages.mjs';

/** @typedef {import('./remote-protocol-messages.mjs').Channel} Channel */

const ENCODER = new TextEncoder();

/**
 * @typedef {{ code: 'too-long' | 'bad-utf8' | 'torn' | 'bad-json' | 'bad-message', message: string, offset: number }} LineError
 * @typedef {{ offset: number, next: number }} LineSpan
 */

/**
 * Splits bytes into lines on \n. It never throws on bad input: a line over maxBytes, or one that isn’t UTF-8, goes to
 * onError and is skipped, and the next line is read as usual. Whatever onLine and onError throw is the caller’s.
 * @param {{ onLine: (text: string, span: LineSpan) => void, onError: (e: LineError) => void, maxBytes?: number,
 *           offset?: number, trailing?: boolean }} opts
 *   offset: the byte offset of the first byte pushed, for reading a log from the middle. trailing: deliver a last line
 *   with no \n at end() (a finished out.jsonl), instead of reporting it torn (a channel that dropped mid-message).
 * @returns {{ push(chunk: Uint8Array | string): void, end(): void }}
 */
export function createLineReader({ onLine, onError, maxBytes = REMOTE_LIMITS.lineBytes, offset = 0, trailing = false }) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  /** @type {Uint8Array[]} */
  let parts = [];
  let held = 0; // bytes of the current line so far, including any being skipped
  let start = offset;
  let skipping = false;
  let ended = false;
  const deliver = (next) => {
    const bytes = parts.length === 1 ? parts[0] : concat(parts, held);
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      onError({ code: 'bad-utf8', message: `The line at byte ${start} isn’t UTF-8.`, offset: start });
      return;
    }
    onLine(text, { offset: start, next });
  };
  const reset = (next) => {
    parts = [];
    held = 0;
    skipping = false;
    start = next;
  };
  return {
    push(chunk) {
      if (ended) return;
      const buf = typeof chunk === 'string' ? ENCODER.encode(chunk) : chunk;
      let i = 0;
      while (i < buf.length) {
        const nl = buf.indexOf(10, i);
        const stop = nl === -1 ? buf.length : nl;
        const n = stop - i;
        if (!skipping && held + n > maxBytes) {
          skipping = true;
          parts = [];
          onError({ code: 'too-long', message: `The line at byte ${start} is over ${maxBytes} bytes, so it was skipped.`, offset: start });
        }
        // A piece kept past this call is copied, since a stream may reuse its buffer.
        if (!skipping && n) parts.push(nl === -1 ? buf.slice(i, stop) : buf.subarray(i, stop));
        held += n;
        if (nl === -1) break;
        const next = start + held + 1;
        if (!skipping) deliver(next);
        reset(next);
        i = nl + 1;
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (!held && !skipping) return;
      if (trailing && !skipping) deliver(start + held);
      else if (!skipping) onError({ code: 'torn', message: `The input ended in the middle of a line, at byte ${start + held}.`, offset: start });
    },
  };
}

/**
 * Reads a channel’s messages from bytes: createLineReader, then parseLine. A refused line goes to onError with its
 * reason, and reading goes on.
 * @param {Channel} channel
 * @param {{ onMessage: (msg: { type: string, [field: string]: any }) => void, onError: (e: LineError) => void, maxBytes?: number }} opts
 */
export function createMessageReader(channel, { onMessage, onError, maxBytes = REMOTE_LIMITS.lineBytes }) {
  return createLineReader({
    maxBytes,
    onError,
    onLine(text, { offset }) {
      const r = parseLine(channel, text);
      if (r.ok) onMessage(r.msg);
      else onError({ code: r.code ?? 'bad-message', message: r.error, offset });
    },
  });
}

function concat(parts, n) {
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
