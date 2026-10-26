// The UAT’s checks live in server/room-checks.mjs, since a recorded room runs them too (designs/telemetry-persona.md, R8).
// A host-mode run (#120) adds its remote rules here (tools/uat/checks-remote.mjs), since they read what only the UAT
// records (facts.hosts) and server code may not import tools/.
import { CHECKS as ROOM_CHECKS, runChecks as runRoomChecks } from '../../server/room-checks.mjs';
import { withRemote } from './checks-remote.mjs';

export * from '../../server/room-checks.mjs';

// The checks, with the remote rules for a host-mode run wrapped around them and added after them.
export const CHECKS = withRemote(ROOM_CHECKS);

/**
 * Runs every check, or only those named, with the remote rules; checks: another list to run instead, as a test passes.
 * @param {any} facts  @param {{ only?: string[] | null, checks?: any[] }} [opts]
 */
export const runChecks = (facts, { only = null, checks = CHECKS } = {}) => runRoomChecks(facts, { only, checks });
