// A host’s connection as the page sees it, and the person’s actions on it (#120; designs/architecture/remote-hosts.md, “Remote hosts”):
// its status, kept in the state (s.hostStatus, 'host.status' events) as the host manager reports it, installing
// Postbox’s host program there, and connecting again. Hosts (host-service.mjs) calls these with itself first.

import { httpError } from '../helpers.mjs';
import { host } from './host-admin.mjs';
import { updateFields } from './install-record.mjs';

/** The host manager, or a refusal that says remote hosts aren’t available. @param {import('./host-service.mjs').Hosts} hosts */
function hostManager(hosts) {
  if (!hosts.manager) throw httpError(503, 'This Postbox wasn’t started with remote hosts, so it can’t connect to one.');
  return hosts.manager;
}

/**
 * A host’s connection as the page shows it: the link’s state, its failure in words with the next step, what the
 * daemon’s welcome said about the host (its home, Node, harnesses and problems, not its turns), and when Postbox last
 * heard from it, and whether Postbox keeps it up to date by itself, with its newest automatic install (its version,
 * when, how it ended, and why the record couldn’t be read or written, never a token or a path). Null before the host
 * manager knows of it.
 * @param {import('./host-service.mjs').Hosts} hosts @param {string} id
 */
export function hostStatus(hosts, id) {
  host(hosts, id);
  const st = hosts.manager?.status(id) ?? null;
  if (!st) return null;
  const f = st.failure ?? null;
  const w = st.welcome ?? null;
  return {
    state: st.state ?? null,
    failure: f && { kind: f.kind ?? 'failed', message: String(f.message ?? ''), next: f.next ?? null, retry: f.retry === true },
    welcome: w && {
      version: w.version,
      home: w.home,
      node: w.node,
      harnesses: w.harnesses ?? [],
      problems: w.problems ?? [],
      // The login PATH as a count, or why it wasn’t used (#672): never its entries.
      ...(w.loginPath ? { loginPath: w.loginPath } : {}),
    },
    lastHeard: st.lastHeard ?? null,
    keepUpdated: st.keepUpdated === true,
    update: updateFields(st.update),
  };
}

/**
 * Sets the person’s standing consent to install this Postbox’s version on the host by itself (#464-b2a), for the
 * page (its toggle in the host editor comes with #464-b2b): the body is exactly { on: true } or { on: false }. Kept in
 * the host’s install record on this computer, never in its settings, so it never reaches the host or an older Postbox.
 * @param {import('./host-service.mjs').Hosts} hosts @param {string} id @param {unknown} body
 */
export async function setHostKeepUpdated(hosts, id, body) {
  host(hosts, id);
  const exact = body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1;
  const on = exact ? /** @type {{ on?: unknown }} */ (body).on : undefined;
  if (typeof on !== 'boolean') throw httpError(422, 'Send { on: true } or { on: false }.');
  await hostManager(hosts).setKeepUpdated(id, on);
  publishHostStatus(hosts, id);
  return { ok: true, keepUpdated: on };
}

/**
 * Keeps each host’s status in the state for the page (s.hostStatus), as other live state reaches it: what the host
 * manager says now, then at each 'status' it emits, and whenever a host is added or changed, so every configured
 * host has one from the start (a host just added has no token here, so it’s not installed, and its card offers
 * Install…). One from before a restart is replaced, since its link is gone. Any change is published, lastHeard too:
 * the manager emits a change to lastHeard alone at most every HEARD_EVERY_MS, though every message moves it.
 * @param {import('./host-service.mjs').Hosts} hosts
 */
export function watchHosts(hosts) {
  for (const id of Object.keys(hosts.store.state.hostStatus ?? {}))
    if (!hosts.manager || !hosts.store.state.hosts?.[id]) hosts.store.emit('host.status', { id, status: null });
  if (!hosts.manager) return;
  for (const id of Object.keys(hosts.store.state.hosts ?? {})) publishHostStatus(hosts, id);
  hosts.manager.on('status', (/** @type {string} */ hostId) => publishHostStatus(hosts, hostId));
  // After the 'host' event has reached every listener, so the page hears of the host before its status.
  hosts.store.subscribe((/** @type {any} */ ev) => ev.type === 'host' && queueMicrotask(() => publishLater(hosts, ev.data?.id)));
}

/** Out of an event, where a throw would reach nothing that could say so. @param {import('./host-service.mjs').Hosts} hosts @param {string|undefined} id */
function publishLater(hosts, id) {
  try {
    publishHostStatus(hosts, id);
  } catch (e) {
    console.error(`Postbox couldn’t read a host’s status: ${e?.message ?? e}`);
  }
}

/** @param {import('./host-service.mjs').Hosts} hosts @param {string|undefined} id */
function publishHostStatus(hosts, id) {
  if (!id || !hosts.store.state.hosts?.[id]) return;
  const status = hostStatus(hosts, id);
  const was = hosts.store.state.hostStatus?.[id] ?? null;
  if (JSON.stringify(status) === JSON.stringify(was)) return;
  hosts.store.emit('host.status', { id, status });
}

/** What installing Postbox’s host program on a host does, for the page’s confirm before it (describeInstall). @param {import('./host-service.mjs').Hosts} hosts @param {string} id */
export async function describeHostInstall(hosts, id) {
  host(hosts, id);
  return await hostManager(hosts).describeInstall(id);
}

/** Installs Postbox’s host program on a host. The page asks first, with describeHostInstall’s text. @param {import('./host-service.mjs').Hosts} hosts @param {string} id */
export async function installHost(hosts, id) {
  host(hosts, id);
  let result;
  try {
    result = await hostManager(hosts).install(id);
  } catch (e) {
    throw hostRefusal(e);
  }
  publishHostStatus(hosts, id);
  // Whether it installed or found this version there; never the daemon’s token, which stays out of what the page
  // reads (server/remote/ssh.mjs, “The daemon’s token”).
  return { ok: true, installed: result?.installed !== false, version: result?.version ?? null };
}

/**
 * Connects to a host now, as the person asked (Retry, Reconnect, Take over): after a failure only they could fix (a
 * sign-in, a host key), to stop waiting out the backoff, or for a host nothing needs, which gets one welcome and then
 * idles. takeover: replace the other Postbox that’s connected to it (busy). The card follows in its status.
 * @param {import('./host-service.mjs').Hosts} hosts @param {string} id @param {{ takeover?: unknown }} [opts]
 */
export function retryHost(hosts, id, { takeover = false } = {}) {
  host(hosts, id);
  if (typeof takeover !== 'boolean') throw httpError(422, 'takeover is true or false.');
  const manager = hostManager(hosts);
  try {
    manager.link(id);
  } catch (e) {
    throw hostRefusal(e);
  }
  // How it went is the host’s status: connected with its welcome, or its failure with the next step.
  manager.connect(id, { takeover }).catch(() => {});
  publishHostStatus(hosts, id);
  return { ok: true };
}

/**
 * A host’s failure (an SshFailure: what happened, and the next step) as the page reads it: a 502 whose error is the
 * message, with `next` and its kind as `code`, rather than a 500 that hides both. One for a host this computer has no
 * token for (not-installed) is a 409, as is the manager’s refusal of a host renamed while a turn still uses its old
 * name (host-renamed-busy: try again once it ends). Anything else is returned as it is, to be thrown.
 * @param {any} e
 */
function hostRefusal(e) {
  if (e?.code === 'host-renamed-busy') return Object.assign(httpError(409, e.message), { code: e.code, next: null });
  if (e?.name !== 'SshFailure') return e;
  return Object.assign(httpError(e.kind === 'not-installed' ? 409 : 502, e.message), { code: e.kind, next: e.next ?? null });
}
