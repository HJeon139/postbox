// What the page loads when it opens (/api/state, server/index.mjs): the state with the seq and epoch it counts within,
// the store’s status, and the configuration the page reads once.

import { HOP_LIMIT } from '../shared/limits.mjs';
import { DEFAULT_EFFORT, EFFORT_LEVELS, REAL_BACKEND_TOOLS } from './adapters/setup.mjs';
import { publicHeaders, publicState } from './public-state.mjs';
import { DEFAULT_MODEL, PERMISSION_MODES } from './runtime.mjs';
import { KNOWN_TOOLS } from './seed.mjs';

/**
 * The answer to GET /api/state.
 * @param {{ store: any, rt: any, adapters: any, origin: string, demo: any, real: any, config: any, headers: any }} ctx
 */
export function pageState({ store, rt, adapters, origin, demo, real, config, headers }) {
  return {
    seq: store.state.seq,
    epoch: store.epoch, // the history the seq counts within; the stream request echoes it (server/live-streams.mjs)
    store: store.status, // whether changes are being saved, and why not (ST-3): the page’s status line
    state: publicState(store.state), // only its public keys (server/public-state.mjs)
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
