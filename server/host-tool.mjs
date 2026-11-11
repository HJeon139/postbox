// The host’s tools that apps can use through the bridge, if granted: the conversation’s assets and narration.

import { listTextAssets, searchAssets } from './asset-search.mjs';
import { blobsOf } from './asset-tools.mjs';
import { roomOf } from './assets.mjs';
import { httpError } from './helpers.mjs';

/** The host tools every agent holds: its conversation’s assets, which its asset tools read too. An app still names them. */
export const HELD_BY_EVERY_AGENT = new Set(['assets.search', 'assets.list']);

/**
 * Runs a host tool for an app, in its conversation.
 * @param {any} rt  the Runtime @param {string} tool @param {any} args @param {{ threadId?: string }} [at]  the app’s thread
 */
export async function hostTool(rt, tool, args = {}, { threadId } = {}) {
  switch (tool) {
    case 'assets.search':
    case 'assets.list': {
      const blobs = blobsOf(rt);
      if (!blobs || !threadId) return [];
      const room = roomOf(rt.s.threads, threadId);
      return tool === 'assets.search' ? searchAssets(rt, blobs, room, args) : listTextAssets(rt, blobs, room);
    }
    case 'narrate.speak':
      if (!rt.narrator) throw httpError(503, 'Narration isn’t installed here. Run npm install to add Kokoro, then restart Postbox.');
      return rt.narrator.speak(args);
    default:
      throw httpError(404, `There’s no host tool called “${tool}”.`);
  }
}
