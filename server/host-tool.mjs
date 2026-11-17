// The host’s tools that apps can use through the bridge, if granted: the conversation’s assets, narration, and public
// data through Postbox (net.fetch).

import { roomOf } from './assets.mjs';
import { httpError } from './helpers.mjs';
import { netFetch } from './net-fetch.mjs';
import { noteFetch } from './net-fetch-line.mjs';

/** The host tools every agent holds: its conversation’s assets, which its asset tools read too, and public data. An app still names them. */
export const HELD_BY_EVERY_AGENT = new Set(['assets.search', 'assets.list', 'net.fetch']);

/**
 * Runs a host tool for an app, in its conversation.
 * @param {import('./app-service.mjs').Apps} apps @param {string} tool @param {any} args
 * @param {{ threadId?: string, app?: any }} [at]  the app’s thread, and the app, whose fetches its agent’s activity shows
 */
export async function hostTool(apps, tool, args = {}, { threadId, app } = {}) {
  switch (tool) {
    case 'assets.search':
    case 'assets.list': {
      if (!threadId) return [];
      const room = roomOf(apps.store.state.threads, threadId);
      return tool === 'assets.search' ? apps.assets.search(room, args) : apps.assets.listText(room);
    }
    case 'narrate.speak':
      if (!apps.narrator) throw httpError(503, 'Narration isn’t installed here. Run npm install to add Kokoro, then restart Postbox.');
      return apps.narrator.speak(args);
    case 'net.fetch': {
      // Public data through Postbox’s server, never the app’s own frame (server/net-fetch.mjs), shown in its agent’s
      // activity as it goes (server/net-fetch-line.mjs).
      const r = await netFetch(args);
      if (app) noteFetch(apps, app, new URL(String(args.url)).host);
      return r;
    }
    default:
      throw httpError(404, `There’s no host tool called “${tool}”.`);
  }
}
