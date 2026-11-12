// Postbox’s side of the fake daemon (tests/fake-daemon.mjs): its messages, read from a stream and validated, to await.

import { createMessageReader } from '../shared/remote-protocol.mjs';

/** How long next() waits for a reply to a message: the daemon answers in a few ms, so 2 s runs out only when it’s broken. */
export const REPLY_MS = 2000;

/**
 * How long next('started') waits: before it says `started`, the daemon writes the turn folder and polls until the
 * runner answers (daemon-start.mjs’s runnerUp). With the remote test files run ten at once, that took up to 1.5 s, and
 * over 2 s in 2 runs of 30 (#1289). It waits for a start that must come, not to show none did, so a long deadline
 * costs time only when the daemon is broken.
 */
export const DAEMON_START_MS = 10_000;

/**
 * Postbox’s side of the fake: reads the daemon’s messages from a stream, validated.
 * @param {import('node:stream').Readable} stream
 * @returns {{ messages: any[], errors: any[], next: (type: string, timeoutMs?: number) => Promise<any>, ended: Promise<void> }}
 *   next(type) resolves with the first message of that type not already taken by an earlier next(), and rejects if
 *   none comes within timeoutMs (DAEMON_START_MS for `started`, else REPLY_MS), naming what did come. At the deadline
 *   it looks once more, after the event loop has read what the stream already holds: a process stalled past the
 *   deadline still sees what came meanwhile.
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
    next(type, timeoutMs = type === 'started' ? DAEMON_START_MS : REPLY_MS) {
      return new Promise((resolve, reject) => {
        // setImmediate runs after the event loop’s poll phase, so the stream’s pending data is read and offered first.
        const timer = setTimeout(
          () =>
            setImmediate(() => {
              offer();
              const i = waiting.findIndex((w) => w.timer === timer);
              if (i === -1) return; // the last look found it
              waiting.splice(i, 1);
              reject(new Error(`No ${type} from the fake daemon within ${timeoutMs} ms; it sent ${messages.map((m) => m.type).join(', ') || 'nothing'}.`));
            }),
          timeoutMs,
        );
        // Left ref’d: the daemon under test unrefs its own timers and file watches (a real one is kept up by its
        // socket), so on Linux, where nothing else is pending, an unref’d wait let the event loop drain mid-test.
        waiting.push({ type, resolve, timer });
        offer();
      });
    },
  };
}
