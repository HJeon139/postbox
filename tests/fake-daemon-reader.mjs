// Postbox’s side of the fake daemon (tests/fake-daemon.mjs): its messages, read from a stream and validated, to await.

import { createMessageReader } from '../shared/remote-protocol.mjs';

/**
 * Postbox’s side of the fake: reads the daemon’s messages from a stream, validated.
 * @param {import('node:stream').Readable} stream
 * @returns {{ messages: any[], errors: any[], next: (type: string, timeoutMs?: number) => Promise<any>, ended: Promise<void> }}
 *   next(type) resolves with the first message of that type not already taken by an earlier next(), and rejects if
 *   none comes within timeoutMs (1 s by default), naming what did come.
 */
export function readMessages(stream) {
  const messages = [];
  const errors = [];
  const taken = new Set();
  /** @type {{ type: string, resolve: (m: any) => void, timer: NodeJS.Timeout }[]} */
  const waiting = [];
  const offer = () => {
    for (const w of [...waiting]) {
      const i = messages.findIndex((m, j) => !taken.has(j) && m.type === w.type);
      if (i === -1) continue;
      taken.add(i);
      waiting.splice(waiting.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(messages[i]);
    }
  };
  const reader = createMessageReader('daemon-to-postbox', {
    onMessage(m) {
      messages.push(m);
      offer();
    },
    onError: (e) => errors.push(e),
  });
  stream.on('data', (b) => reader.push(b));
  const ended = new Promise((resolve) =>
    stream.on('end', () => {
      reader.end();
      resolve();
    }),
  );
  return {
    messages,
    errors,
    ended,
    next(type, timeoutMs = 1000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.splice(
            waiting.findIndex((w) => w.timer === timer),
            1,
          );
          reject(new Error(`No ${type} from the fake daemon within ${timeoutMs} ms; it sent ${messages.map((m) => m.type).join(', ') || 'nothing'}.`));
        }, timeoutMs);
        // Left ref’d: the daemon under test unrefs its own timers and file watches (a real one is kept up by its
        // socket), so on Linux, where nothing else is pending, an unref’d wait let the event loop drain mid-test.
        waiting.push({ type, resolve, timer });
        offer();
      });
    },
  };
}
