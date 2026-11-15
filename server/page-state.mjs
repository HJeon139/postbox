// What the page loads when it opens (/api/state, server/index.mjs): the state with the seq and epoch it counts within,
// the store’s status, and the configuration the page reads once.

import { HOP_LIMIT } from '../shared/limits.mjs';
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_LEVELS, REAL_BACKEND_TOOLS } from './adapters/setup.mjs';
import { publicHeaders, publicState } from './public-state.mjs';
import { PERMISSION_MODES } from './runtime.mjs';
import { KNOWN_TOOLS } from './seed.mjs';

/**
 * Each agent’s inbox as the page can act on it: entries waiting, taken by a turn, failed or stopped. Delivered ones stay
 * in the state and the log, so the answer doesn’t grow with a room’s history (#1155’s bound, for items). The stream’s
 * entry events keep the page’s copy current from here.
 * @param {Record<string, any[]>} inbox
 */
function openEntries(inbox) {
  const open = Object.create(null);
  for (const [sessionId, entries] of Object.entries(inbox ?? {})) {
    const kept = entries.filter((e) => e.state !== 'delivered');
    if (kept.length) open[sessionId] = kept;
  }
  return open;
}

/**
 * The answer to GET /api/state.
 * @param {{ store: any, rt: any, adapters: any, origin: string, demo: any, real: any, config: any, headers: any }} ctx
 */
export function pageState({ store, rt, adapters, origin, demo, real, config, headers }) {
  return {
    seq: store.state.seq,
    epoch: store.epoch, // the history the seq counts within; the stream request echoes it (server/live-streams.mjs)
    store: store.status, // whether changes are being saved, and why not (ST-3): the page’s status line
    // Only its public keys (server/public-state.mjs), and no conversation’s items: the page loads those by range when it
    // opens a conversation (/api/threads/:id/items, #1155), so opening the page costs the conversations, not their history.
    state: { ...publicState(store.state), items: {}, inbox: openEntries(store.state.inbox) },
    // Each thread’s header facts (shared/thread-header.mjs, #1155): what the page shows about a thread without its items.
    headers: publicHeaders(headers.all()),
    config: {
      origin,
      // Postbox’s tools, then those only real backends have (#5).
      knownTools: [...KNOWN_TOOLS, ...REAL_BACKEND_TOOLS],
      // The backends that run on this computer.
      adapters: rt.localBackends(),
      // What each one can do (#117), so the page hides what a backend can’t honor rather than checking its name;
      // local: whether it runs on this computer, since one that can run on a host is listed without its CLI here.
      backends: Object.fromEntries(adapters.names().map((n) => [n, { ...(adapters.get(n).capabilities ?? {}), local: adapters.runsHere(n) }])),
      defaultModel: DEFAULT_MODEL,
      effortLevels: EFFORT_LEVELS,
      defaultEffort: DEFAULT_EFFORT,
      permissionModes: PERMISSION_MODES,
      // The server’s wake chain limit for a room with none of its own (#1035): the browser’s shared/limits.mjs knows
      // only the default, not POSTBOX_CHAIN_LIMIT.
      defaultChainLimit: HOP_LIMIT,
      demo,
      // Whether Postbox looked for real backends, and the Claude Code it found: if none, the overview says how (#12).
      realBackends: real,
      versions: config.versions,
      build: config.build,
    },
  };
}
