// The ids Postbox makes for what it stores: conversations, items, sessions, the store’s epoch and the rest.

import { randomBytes } from 'node:crypto';

const ID_LENGTH = 8; // letters or digits after an id’s prefix

/**
 * An id: its prefix, `_`, and exactly 8 letters or digits (#713; designs/508/storage-design.md, “The history epoch”).
 * Six random bytes encode to 8 base64url characters; `-` and `_` are dropped, and it draws again until it has 8.
 * Each character is kept 62 times in 64, so it takes about 1.22 draws, 7.3 bytes, on average.
 * @param {string} prefix @param {(n: number) => Buffer} [bytes]  the random source; a test gives its own
 */
export function newId(prefix, bytes = randomBytes) {
  let chars = '';
  while (chars.length < ID_LENGTH) {
    chars += bytes(6).toString('base64url').replace(/[-_]/g, '');
  }
  return `${prefix}_${chars.slice(0, ID_LENGTH)}`;
}
