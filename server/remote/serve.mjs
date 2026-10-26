// What Postbox’s server does for remote hosts (#120) as it starts and stops (server/index.mjs): it makes the host
// manager, attaches the turns that went on on their hosts across a restart, keeps each host’s status in the state,
// reconnects the hosts when this computer wakes, and closes their links last.

import { createHostManager } from './hosts.mjs';
import { watchWake } from './wake.mjs';

/** @typedef {import('./hosts.mjs').HostManager} HostManager */

/**
 * The hosts’ links, made on first use: the manager reads each host from the runtime as it opens a session, so a
 * change to its settings reaches the next one. given: the manager the server was started with (tests pass a fake,
 * or null for none); left out, Postbox makes its own, keeping the hosts’ tokens in dataDir.
 * @param {HostManager|null|undefined} given @param {() => any} runtime  the Runtime, once it’s made
 * @param {string} dataDir @param {string} version
 * @returns {HostManager|null}
 */
export function hostManagerFor(given, runtime, dataDir, version) {
  if (given !== undefined) return given;
  return createHostManager({
    getHost: (id) => runtime().s.hosts?.[id] ?? null,
    // Every configured host, so a wake reconnects each one with a token (D2).
    hostIds: () => Object.keys(runtime().s.hosts ?? {}),
    dataDir,
    version,
  });
}

/**
 * At startup: turns that were running on a remote host went on there, and are attached again once the host answers.
 * Each host’s connection goes in the state for the page; and when this computer wakes, the hosts reconnect at once
 * (D2), rather than when a backoff timer that slept too comes round. Returns what stops watching for the wake.
 * @param {any} rt @param {HostManager|null} hosts @param {Parameters<typeof watchWake>[1]} wake
 */
export function startHosts(rt, hosts, wake) {
  rt.restoreRemoteTurns();
  rt.watchHosts();
  return hosts ? watchWake(() => hosts.wake(), wake) : null;
}

/**
 * As Postbox stops, after the turns, whose Stop goes to their hosts over these links.
 * @param {HostManager|null} hosts @param {(() => void) | null} stopWake
 */
export async function stopHosts(hosts, stopWake) {
  stopWake?.();
  await hosts?.close();
}
