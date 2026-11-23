// A fake the prompt-recording tests share (tests/turn-prompt.test.mjs, tests/adapter-prompts.test.mjs, #1528).

import { Writable } from 'node:stream';

/**
 * A stdin whose write fails asynchronously with EPIPE, as Node’s pipe does once its reader has exited: the write’s
 * error reaches the stream’s 'error' and end()’s callback, as it does for a real child’s stdin.
 */
export function brokenStdin() {
  return new Writable({
    write: (_chunk, _enc, cb) => setImmediate(() => cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))),
  });
}
