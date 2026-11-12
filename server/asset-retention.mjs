// What an asset version prunes, and what a room’s kept versions weigh (#516 S3, designs/architecture/assets.md, “Assets”). The
// person’s rule of 2 November 2026: text keeps every version; a large binary keeps its last few; a version is pruned
// only in the commit of the version that makes it prunable, never at another time and never to make room.

import { ASSETS } from '../shared/limits.mjs';
import { own } from '../shared/state-assets.mjs';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether bytes are text, for the retention rule: the whole of them decodes as UTF-8, with no NUL byte.
 * @param {Uint8Array} bytes
 */
export function isTextBytes(bytes) {
  if (bytes.includes(0)) return false;
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The version a new head makes prunable, as a list of none or one: the one that now has ASSETS.binaryVersionsKept
 * newer versions, and at least one, since the head is never pruned. It goes when it’s a binary over
 * ASSETS.largeBinaryBytes, not pruned yet. Never a text version, a small binary or a delete. Each commit prunes the one
 * it makes prunable, so no older version is left to find. Nothing pins a version yet; the slices that add pins (#516 S6
 * and S8) add the check with them.
 * @param {any[]} versions  the asset’s versions, the new head last
 * @param {{ largeBinaryBytes?: number, binaryVersionsKept?: number }} [limits]
 * @returns {number[]} its version number, or none
 */
export function prunable(versions, { largeBinaryBytes = ASSETS.largeBinaryBytes, binaryVersionsKept = ASSETS.binaryVersionsKept } = {}) {
  const x = versions[versions.length - 1 - Math.max(binaryVersionsKept, 1)];
  const goes = x?.sha256 && !x.isText && !x.pruned && x.size > largeBinaryBytes;
  return goes ? [x.v] : [];
}

/**
 * The bytes a room keeps after a commit adds a version and prunes others, from its index (shared/state-assets.mjs):
 * a file it doesn’t keep yet adds its size, and a pruned file’s last keeper takes its size off.
 * @param {{ bytes: number, files: Record<string, { n: number, size: number }> }} index  the room’s index, or an empty one
 * @param {{ sha256: string | null, size: number }} added  the new version
 * @param {{ sha256: string }[]} pruned  the versions the commit prunes
 */
export function bytesAfter(index, added, pruned) {
  const adds = added.sha256 && !own(index.files, added.sha256) ? added.size : 0;
  const frees = pruned
    .map((x) => own(index.files, x.sha256))
    .filter((file, i) => file?.n === 1 && pruned[i].sha256 !== added.sha256)
    .reduce((sum, file) => sum + file.size, 0);
  return index.bytes + adds - frees;
}
