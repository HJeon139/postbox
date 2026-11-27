// What the page loads when it opens (/api/state, server/index.mjs): the state with the seq and epoch it counts within,
// the store’s status, and the configuration the page reads once.

import { pageInbox } from '../shared/inbox-page.mjs';
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_LEVELS, REAL_BACKEND_TOOLS } from './adapters/setup.mjs';
import { liveSnapshots } from './live-buffer.mjs';
import { publicHeaders, publicLive, publicState } from './public-state.mjs';
import { PERMISSION_MODES } from './runtime.mjs';
import { KNOWN_TOOLS } from './seed.mjs';

/**
 * The answer to GET /api/state.
 * @param {{ store: any, rt: any, adapters: any, origin: string, demo: any, real: any, config: any, headers: any, me?: any }} ctx
 */
export function pageState({ store, rt, adapters, origin, demo, real, config, headers, me = null }) {
  return {
    seq: store.state.seq,
    epoch: store.epoch, // the history the seq counts within; the stream request echoes it (server/live-streams.mjs)
    store: store.status, // whether changes are being saved, and why not (ST-3): the page’s status line
    // Only its public keys (server/public-state.mjs), and no conversation’s items: the page loads those by range when it
    // opens a conversation (/api/threads/:id/items, #1155), so opening the page costs the conversations, not their history.
    state: { ...publicState(store.state), items: {}, inbox: pageInbox(store.state.inbox) },
    // Each thread’s header facts (shared/thread-header.mjs, #1155): what the page shows about a thread without its items.
    headers: publicHeaders(headers.all()),
    // The running turns’ live state, for a page that loads mid-turn (live-progress.md, “The buffer”), as it may see it.
    live: publicLive(liveSnapshots(rt)),
    config: {
      origin,
      // Who is looking (#558), as the request gate resolved them: their record, or who their provider says they are
      // while they’ve saved nothing. Their own, so all of it.
      me,
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
      demo,
      // Whether Postbox looked for real backends, and the Claude Code it found: if none, the overview says how (#12).
      realBackends: real,
      versions: config.versions,
      build: config.build,
    },
  };
}
