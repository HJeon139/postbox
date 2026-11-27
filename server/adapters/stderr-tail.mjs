// The end of what a CLI writes to stderr, for the error a turn fails with (#1938, #1952). Decoded as one stream, so a
// character whose bytes land in two pipe chunks stays whole, and cut on a character, so the tail never starts inside
// one (tailText).

import { tailText } from '../../shared/text-parts.mjs';

/**
 * Keeps the last n characters a child writes to stderr, and returns a function that reads them.
 * @param {{ stderr: import('node:stream').Readable }} child @param {number} [n]
 * @returns {() => string}
 */
export function stderrTail(child, n = 4000) {
  let kept = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    kept = tailText(kept + d, n);
  });
  return () => kept;
}
