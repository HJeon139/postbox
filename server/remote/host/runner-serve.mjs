// The runner’s side of the turn’s socket (runner.mjs’s header, #120): `who` with the host’s token gets `iam`, and
// after it, `stdin` lines for a held stdin go to in.jsonl and then the harness’s pipe.

import { timingSafeEqual } from 'node:crypto';
import { fstatSync, readFileSync, writeSync } from 'node:fs';
import { createMessageReader, encode, message } from '../../../shared/remote-protocol.mjs';

/** Whether a `who` carries the host’s token. Read each time, so it’s never older than the file. @param {string} path @param {string} given */
function tokenMatches(path, given) {
  let want;
  try {
    want = Buffer.from(readFileSync(path, 'utf8').trim());
  } catch {
    return false;
  }
  const got = Buffer.from(given);
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Answers one daemon connection: `who` with the token gets `iam`; after that, `stdin` lines for a held stdin.
 * @param {import('node:net').Socket} conn
 * @param {{ turn: string, tokenPath: string, inFd: number | null, pipe: () => import('node:stream').Writable | null }} ctx
 */
export function serve(conn, { turn, tokenPath, inFd, pipe }) {
  let trusted = false;
  const send = (/** @type {string} */ type, /** @type {Record<string, unknown>} */ body) => {
    if (conn.writable) conn.write(encode(message('runner-to-daemon', type, body)));
  };
  /** @param {string} code @param {string} text @param {string} [re]  the type of the message it answers */
  const fail = (code, text, re) => send('error', { code, message: text, turn, ...(re ? { re } : {}) });
  /** @param {{ type: string, [k: string]: any }} msg */
  async function handle(msg) {
    if (msg.type === 'who') {
      if (!tokenMatches(tokenPath, msg.token)) {
        fail('bad-token', 'That isn’t the host’s token.', 'who');
        conn.end();
        return;
      }
      trusted = true;
      send('iam', { turn, pid: process.pid });
      return;
    }
    if (!trusted) return fail('not-ready', 'Send who with the token first.', 'stdin');
    if (inFd === null) return fail('not-held', 'This turn’s stdin isn’t held.', 'stdin');
    const out = pipe();
    if (!out) return fail('turn-ended', 'The harness’s stdin is closed.', 'stdin');
    const line = `${msg.line}\n`;
    writeSync(inFd, line);
    const upTo = fstatSync(inFd).size;
    const ok = await new Promise((resolve) => out.write(line, (err) => resolve(!err)));
    if (!ok) return fail('turn-ended', 'The harness’s stdin closed before the line reached it.', 'stdin');
    send('written', { upTo });
  }
  // One message at a time, in order: a line is in in.jsonl and in the pipe before the next is looked at.
  let queue = Promise.resolve();
  const reader = createMessageReader('daemon-to-runner', {
    onMessage(msg) {
      queue = queue.then(() => handle(msg)).catch(() => void conn.destroy());
    },
    onError(e) {
      queue = queue.then(() => fail('bad-message', e.message));
    },
  });
  conn.on('data', (chunk) => reader.push(chunk));
  conn.on('end', () => reader.end());
}
