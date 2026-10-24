// A host’s connection as the page sees it, and the person’s actions on it (#120; architecture.md, “Remote hosts”):
// its status, kept in the state (s.hostStatus, 'host.status' events) as the host manager reports it, installing
// Postbox’s host program there, and connecting again. The runtime (server/runtime.mjs) calls these with itself first.

import { httpError } from '../helpers.mjs';
import { host } from './host-admin.mjs';

/** The host manager, or a refusal that says remote hosts aren’t available. @param {any} rt */
function hostManager(rt) {
  if (!rt.hosts) throw httpError(503, 'This Postbox wasn’t started with remote hosts, so it can’t connect to one.');
  return rt.hosts;
}

/**
 * A host’s connection as the page shows it: the link’s state, its failure in words with the next step, what the
 * daemon’s welcome said about the host (its home, Node, harnesses and problems, not its turns), and when Postbox last
 * heard from it. Null before the host manager knows of it.
 * @param {any} rt @param {string} id
 */
export function hostStatus(rt, id) {
  host(rt, id);
  const st = rt.hosts?.status(id) ?? null;
  if (!st) return null;
  const f = st.failure ?? null;
  const w = st.welcome ?? null;
  return {
    state: st.state ?? null,
    failure: f && { kind: f.kind ?? 'failed', message: String(f.message ?? ''), next: f.next ?? null, retry: f.retry === true },
    welcome: w && { version: w.version, home: w.home, node: w.node, harnesses: w.harnesses ?? [], problems: w.problems ?? [] },
    lastHeard: st.lastHeard ?? null,
  };
}

/**
 * Keeps each host’s status in the state for the page (s.hostStatus), as other live state reaches it: what the host
 * manager says now, then at each 'status' it emits. One from before a restart is replaced, since its link is gone.
 * Any change is published, lastHeard too: the manager emits a change to lastHeard alone at most every
 * HEARD_EVERY_MS, though every message moves it.
 * @param {any} rt
 */
export function watchHosts(rt) {
  for (const id of Object.keys(rt.s.hostStatus ?? {})) if (!rt.hosts || !rt.s.hosts?.[id]) rt.store.emit('host.status', { id, status: null });
  if (!rt.hosts) return;
  for (const id of Object.keys(rt.s.hosts ?? {})) publishHostStatus(rt, id);
  rt.hosts.on('status', (/** @type {string} */ hostId) => publishHostStatus(rt, hostId));
}

/** @param {any} rt @param {string|undefined} id */
function publishHostStatus(rt, id) {
  if (!id || !rt.s.hosts?.[id]) return;
  const status = hostStatus(rt, id);
  const was = rt.s.hostStatus?.[id];
  if (was !== undefined && JSON.stringify(status) === JSON.stringify(was)) return;
  rt.store.emit('host.status', { id, status });
}

/** What installing Postbox’s host program on a host does, for the page’s confirm before it (describeInstall). @param {any} rt @param {string} id */
export async function describeHostInstall(rt, id) {
  host(rt, id);
  return await hostManager(rt).describeInstall(id);
}

/** Installs Postbox’s host program on a host. The page asks first, with describeHostInstall’s text. @param {any} rt @param {string} id */
export async function installHost(rt, id) {
  host(rt, id);
  let result;
  try {
    result = await hostManager(rt).install(id);
  } catch (e) {
    throw hostRefusal(e);
  }
  publishHostStatus(rt, id);
  // Whether it installed or found this version there; never the daemon’s token, which stays out of what the page
  // reads (server/remote/ssh.mjs, “The daemon’s token”).
  return { ok: true, installed: result?.installed !== false, version: result?.version ?? null };
}

/**
 * Connects to a host now, as the person asked (Retry, Reconnect, Take over): after a failure only they could fix (a
 * sign-in, a host key), to stop waiting out the backoff, or for a host nothing needs, which gets one welcome and then
 * idles. takeover: replace the other Postbox that’s connected to it (busy). The card follows in its status.
 * @param {any} rt @param {string} id @param {{ takeover?: unknown }} [opts]
 */
export function retryHost(rt, id, { takeover = false } = {}) {
  host(rt, id);
  if (typeof takeover !== 'boolean') throw httpError(422, 'takeover is true or false.');
  const hosts = hostManager(rt);
  try {
    hosts.link(id);
  } catch (e) {
    throw hostRefusal(e);
  }
  // How it went is the host’s status: connected with its welcome, or its failure with the next step.
  hosts.connect(id, { takeover }).catch(() => {});
  publishHostStatus(rt, id);
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
