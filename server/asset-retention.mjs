// What an asset version prunes, and what a room’s kept versions weigh (#516 S3, designs/architecture.md, “Assets”). The
// person’s rule of 2 November 2026: text keeps every version; a large binary keeps its last few; a version is pruned
// only in the commit of the version that makes it prunable, never at another time and never to make room.

import { ASSETS } from '../shared/limits.mjs';

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
 * The versions a new head makes prunable: binary versions over ASSETS.largeBinaryBytes, not pruned yet, with at least
 * ASSETS.binaryVersionsKept newer versions. Never the head, a text version, a small binary or a delete. Nothing pins a
 * version yet; the slices that add pins (#516 S6 and S8) add the check with them.
 * @param {any[]} versions  the asset’s versions, the new head last
 * @param {{ largeBinaryBytes?: number, binaryVersionsKept?: number }} [limits]
 * @returns {number[]} their version numbers
 */
export function prunable(versions, { largeBinaryBytes = ASSETS.largeBinaryBytes, binaryVersionsKept = ASSETS.binaryVersionsKept } = {}) {
  const head = versions.at(-1);
  return versions
    .filter((x) => x !== head && x.sha256 && !x.isText && !x.pruned && x.size > largeBinaryBytes)
    .filter((x) => versions.filter((y) => y.v > x.v).length >= binaryVersionsKept)
    .map((x) => x.v);
}

/**
 * The bytes a room keeps: every version not pruned, each distinct file counted once, with `prunes` taken off and
 * `added` counted, as the commit would leave them.
 * @param {Record<string, any>} assets  the state’s assets
 * @param {string} room
 * @param {{ prunes?: { id: string, vs: number[] }, added?: { sha256: string, size: number } | null }} [change]
 */
export function roomBytes(assets, room, { prunes, added = null } = {}) {
  const sizes = new Map();
  for (const asset of Object.values(assets)) {
    if (asset.room !== room) continue;
    for (const x of asset.versions) {
      const goes = Boolean(prunes && prunes.id === asset.id && prunes.vs.includes(x.v));
      if (x.sha256 && !x.pruned && !goes) sizes.set(x.sha256, x.size);
    }
  }
  if (added?.sha256) sizes.set(added.sha256, added.size);
  let total = 0;
  for (const n of sizes.values()) total += n;
  return total;
}
