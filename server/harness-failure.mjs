// One classifier of a harness’s failures (#466, #467, #442, #1713): a turn lost to the network, one its backend refused
// for quota, or one its provider failed for a while (overloaded, or a server error), read from structured marks on the
// error the adapter threw and its causes, never from its words. Each adapter marks what its harness says: a network
// code (`code`), an unreachable host (`kind: 'unreachable'`), a quota with its reset time (`quota`, withQuota), or the
// HTTP status of a provider error that passes (`transient`, withTransient).

/** The codes of a network that went away under a turn (#466): seen from ssh, Kiro and Node’s own sockets. */
export const NETWORK_CODES = Object.freeze(['EADDRNOTAVAIL', 'ENOTFOUND', 'ECONNRESET']);
const NETWORK = new Set(NETWORK_CODES);

/**
 * The HTTP statuses of a provider error that passes on its own (#1713): rate limited (when it isn’t the quota), a
 * server error, a gateway that timed out or had no answer, and Anthropic’s 529 Overloaded.
 */
export const TRANSIENT_STATUSES = Object.freeze([429, 500, 502, 503, 504, 529]);
const TRANSIENT = new Set(TRANSIENT_STATUSES);

/** @typedef {{ kind: 'network' } | { kind: 'quota', until: number | null } | { kind: 'transient', status: number }} HarnessFailure */

/**
 * What kind of failure an error is, from its marks and its causes’, or null when it’s none the harness classes.
 * @param {any} error @returns {HarnessFailure | null}
 */
export function failureClass(error) {
  for (let e = error, depth = 0; e && depth < 10; e = e.cause, depth++) {
    if (e.quota) return { kind: 'quota', until: Number.isFinite(e.quota.until) ? e.quota.until : null };
    if (e.kind === 'unreachable' || NETWORK.has(e.code)) return { kind: 'network' };
    if (e.transient) return { kind: 'transient', status: e.transient.status };
  }
  return null;
}

/** Whether an error says the network was unavailable. @param {any} error */
export const isNetworkFailure = (error) => failureClass(error)?.kind === 'network';

/**
 * Marks an error as the backend refusing for quota, with when the quota resets (epoch ms) when the harness said, when
 * there’s a quota to mark. @param {Error} error @param {{ until: number | null } | null | undefined} quota
 */
export function withQuota(error, quota) {
  if (quota) Object.assign(error, { quota: { until: Number.isFinite(quota.until) ? quota.until : null } });
  return error;
}

/**
 * Marks an error as a provider failure that passes on its own, with the HTTP status the harness gave, when that status
 * is one (TRANSIENT_STATUSES). A quota already marked wins: a 429 that ran the quota out waits for its reset (#442).
 * @param {Error} error @param {unknown} status  the harness’s structured status, such as Claude Code’s api_error_status
 */
export function withTransient(error, status) {
  if (typeof status === 'number' && TRANSIENT.has(status) && !(/** @type {any} */ (error).quota)) Object.assign(error, { transient: { status } });
  return error;
}
