// Hosts (designs/architecture/services.md, “Hosts”): the person’s remote hosts (#120; designs/architecture/remote-hosts.md):
// adding one, renaming it or changing its settings, removing it, a project’s folder on one (host-admin.mjs), and its
// status as the page sees it, installing Postbox’s host program there, keeping it up to date and connecting again
// (host-status.mjs). Hosts is a service: Runtime’s constructor builds it with the store, Personas and Running, the
// `hostTurns` port and the host manager, and its modules take it, never the runtime. The turns on a host, which wait
// for rooms at scale with the rest of Turns, are reached only through `hostTurns`.

import { addHost, host, removeHost, setProjectHostFolder, updateHost } from './host-admin.mjs';
import { describeHostInstall, hostStatus, installHost, retryHost, setHostKeepUpdated, watchHosts } from './host-status.mjs';

/**
 * @typedef {{ busyOn: (hostId: string) => boolean, sessionsOn: (hostId: string) => string[],
 *             stopOn: (sessionId: string) => boolean, cancel: (sessionId: string) => boolean,
 *             confirmStops: (hostId: string, waitMs: number) => Promise<{ left: string[], noToken: boolean }>,
 *             stoppingSession: (turnId: string) => string|null|undefined }} HostTurns
 *   The host turns that a rename refuses for and a removal stops (the port; designs/architecture/services.md, “The
 *   services”): whether any runs or waits on a host, the sessions with one there, Stop for one, giving up one waiting to
 *   be attached again, the host’s confirmation that those it stopped are over, and whose a stopped one was.
 */

export class Hosts {
  /**
   * @param {{ store: import('../store.mjs').Store, personas: { get: (id: string) => any },
   *           running: { exitOf: (sessionId: string) => any }, hostTurns: HostTurns,
   *           hosts: import('./hosts.mjs').HostManager | any | null }} deps
   *   hosts: the remote hosts’ manager (server/remote/hosts.mjs), which reaches each host’s daemon; without it, nothing
   *   connects to a host. Kept as `manager`.
   */
  constructor({ store, personas, running, hostTurns, hosts }) {
    this.store = store;
    this.personas = personas;
    this.running = running;
    this.hostTurns = hostTurns;
    this.manager = hosts ?? null;
  }

  // ── The person’s hosts ─────────────────────────────────────────────────────────────

  /** A host, or a 404. @param {string} id */
  get(id) {
    return host(this, id);
  }

  /** @param {{ name?: unknown, short?: unknown, settings?: unknown }} [opts] */
  add(opts) {
    return addHost(this, opts);
  }

  /** @param {string} id @param {{ name?: unknown, short?: unknown, settings?: unknown }} [patch] */
  update(id, patch) {
    return updateHost(this, id, patch);
  }

  /** Stops its turns, waits for the host to confirm, removes Postbox there, then forgets it. @param {string} id @param {{ waitMs?: number }} [opts] */
  remove(id, opts) {
    return removeHost(this, id, opts);
  }

  /** @param {string} projectId @param {string} hostId @param {unknown} folder  an absolute path there, or null */
  setProjectFolder(projectId, hostId, folder) {
    return setProjectHostFolder(this, projectId, hostId, folder);
  }

  // ── Its connection ─────────────────────────────────────────────────────────────────

  /** A host’s connection as the page shows it, or null before the manager knows of it. @param {string} id */
  status(id) {
    return hostStatus(this, id);
  }

  /** Keeps each host’s status in the state for the page, from when Postbox listens. */
  watch() {
    watchHosts(this);
  }

  /** @param {string} id */
  describeInstall(id) {
    return describeHostInstall(this, id);
  }

  /** @param {string} id */
  install(id) {
    return installHost(this, id);
  }

  /** @param {string} id @param {{ takeover?: unknown }} [opts] */
  retry(id, opts) {
    return retryHost(this, id, opts);
  }

  /** The person’s standing consent to keep the host up to date (#464-b2a). @param {string} id @param {unknown} body */
  setKeepUpdated(id, body) {
    return setHostKeepUpdated(this, id, body);
  }
}
