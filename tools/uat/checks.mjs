// The UAT’s checks live in tools/uat/room-checks.mjs. A host-mode run (#120) adds its remote rules here
// (tools/uat/checks-remote.mjs), since they read what only the UAT records (facts.hosts) and server code may not import
// tools/. So do the asset store’s checks (tools/uat/checks-assets.mjs),
// which read the store a run left and what its tester did, and the view’s (tools/uat/checks-view.mjs), which read the
// page’s probes.

import { ASSET_STORE_CHECKS } from './checks-assets.mjs';
import { withRemote } from './checks-remote.mjs';
import { VIEW_CHECKS } from './checks-view.mjs';
import { CHECKS as ROOM_CHECKS, runChecks as runRoomChecks } from './room-checks.mjs';

export * from './room-checks.mjs';

// The checks, the asset store’s and the view’s, with the remote rules for a host-mode run wrapped around them and added after them.
export const CHECKS = withRemote([...ROOM_CHECKS, ...ASSET_STORE_CHECKS, ...VIEW_CHECKS]);

/**
 * Runs every check, or only those named, with the remote rules; checks: another list to run instead, as a test passes.
 * @param {any} facts  @param {{ only?: string[] | null, checks?: any[] }} [opts]
 */
export const runChecks = (facts, { only = null, checks = CHECKS } = {}) => runRoomChecks(facts, { only, checks });

/**
 * Removes the check findings that say a check couldn’t vouch for the run (unverified rows), so the run’s last pass
 * decides them on its final facts: each describes the whole run, and the runner otherwise keeps the first of a key, as
 * an early step found it. O(findings). @param {Map<string, any>} findings
 */
export function dropUnverified(findings) {
  for (const [key, f] of findings) {
    if (f.source === 'check' && f.unverified) findings.delete(key);
  }
}

/**
 * The run’s last check pass, after its last step: the unverified rows are dropped first, so each comes back with the
 * run’s final evidence, or not at all. newFindings is the runner’s, which adds what runChecks finds that’s new.
 * @param {Map<string, any>} findings  @param {() => any[]} newFindings
 */
export function lastCheckPass(findings, newFindings) {
  dropUnverified(findings);
  return newFindings();
}
