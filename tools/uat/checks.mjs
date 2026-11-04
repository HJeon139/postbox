// The UAT’s checks live in server/room-checks.mjs, since a recorded room runs them too (designs/telemetry-persona.md, R8).
// A host-mode run (#120) adds its remote rules here (tools/uat/checks-remote.mjs), since they read what only the UAT
// records (facts.hosts) and server code may not import tools/. So do the asset store’s checks (tools/uat/checks-assets.mjs),
// which read the store a run left and what its tester did, and the view’s (tools/uat/checks-view.mjs), which read the
// page’s probes.
import { CHECKS as ROOM_CHECKS, runChecks as runRoomChecks } from '../../server/room-checks.mjs';
import { ASSET_STORE_CHECKS } from './checks-assets.mjs';
import { withRemote } from './checks-remote.mjs';
import { VIEW_CHECKS } from './checks-view.mjs';

export * from '../../server/room-checks.mjs';

// The checks, the asset store’s and the view’s, with the remote rules for a host-mode run wrapped around them and added after them.
export const CHECKS = withRemote([...ROOM_CHECKS, ...ASSET_STORE_CHECKS, ...VIEW_CHECKS]);

/**
 * Runs every check, or only those named, with the remote rules; checks: another list to run instead, as a test passes.
 * @param {any} facts  @param {{ only?: string[] | null, checks?: any[] }} [opts]
 */
export const runChecks = (facts, { only = null, checks = CHECKS } = {}) => runRoomChecks(facts, { only, checks });
