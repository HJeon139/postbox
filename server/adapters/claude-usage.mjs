// What a Claude Code turn spent (#295). A result’s total_cost_usd and modelUsage run for the session, across
// --resume, not for the process: three resumed `claude -p` turns of one session (claude 2.1.310, Haiku) reported
// total_cost_usd 0.003123, 0.005951 and 0.008789, and modelUsage input tokens 2, 4 and 6, while each result’s own
// usage was that turn’s. So a turn’s cost is its result’s total less the session’s total before the turn, and its
// tokens are its results’ own usage. The session’s totals are what
// the adapter saves when a turn ends (ctx.state.spent), so a turn replayed after a restart still subtracts the last.

/**
 * The session’s totals in a result: its cost, and its tokens summed over models.
 * @param {any} e  a result event
 * @returns {{ sessionId: string|null, costUsd: number|null, tokens: Record<string, number>|null }}
 */
export function sessionTotals(e) {
  const models = Object.values(e?.modelUsage ?? {});
  /** @param {string} k */
  const sum = (k) => models.reduce((n, u) => n + (Number(u?.[k]) || 0), 0);
  return {
    sessionId: typeof e?.session_id === 'string' ? e.session_id : null,
    costUsd: typeof e?.total_cost_usd === 'number' ? e.total_cost_usd : null,
    tokens: models.length
      ? { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadInputTokens'), cacheWrite: sum('cacheCreationInputTokens') }
      : null,
  };
}

/** a less b, when b is a number no larger: a running total less where it stood. Otherwise a, as a new session. */
const less = (/** @type {number} */ a, /** @type {unknown} */ b) => (typeof b === 'number' && a >= b ? Math.round((a - b) * 1e6) / 1e6 : a);

/**
 * A result’s own tokens: its usage is per result, not a running total (each resumed turn above reported 2 input
 * tokens), so a turn’s tokens are its results’ usage added up (claude-stream.mjs).
 * @param {any} e  a result event @returns {Record<string, number>|null}
 */
export function resultTokens(e) {
  const u = e?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (/** @type {unknown} */ v) => (Number.isFinite(v) ? Number(v) : 0);
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
}

/**
 * A turn’s own cost: its result’s total less the session’s before the turn, when before is the same session’s. A
 * fork’s total includes the session it forked: two sessions resumed in turn in one folder each ran on their own
 * totals, and a `--fork-session` of the first reported 0.011635 against its parent’s 0.008787 (claude 2.1.310). So a
 * fork from the latest point of the session before was taken from subtracts it, and any other fork’s cost is unknown
 * (null) rather than counted again. A new session subtracts nothing.
 * @param {ReturnType<typeof sessionTotals>} totals @param {any} before  the session’s totals when the turn started
 * @param {{ id: string|null, uuid?: string|null }|null} [fork]  the session this turn forks, and where
 * @returns {number|null}
 */
export function turnCost(totals, before, fork = null) {
  if (totals.costUsd === null) return null;
  const same = before?.sessionId && before.sessionId === totals.sessionId;
  const forkedFromBefore = fork && !fork.uuid && before?.sessionId && before.sessionId === fork.id;
  if (same || forkedFromBefore) return less(totals.costUsd, before.costUsd);
  return fork ? null : totals.costUsd;
}

/** Two token counts added up, either of which may be missing. @param {Record<string, number>|null} a @param {Record<string, number>|null} b */
export const addTokens = (a, b) => (!a ? b : !b ? a : Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + (b[k] ?? 0)])));

/**
 * The session a turn forks, from the adapter’s state (claude-code.mjs forkPoint, agent-sdk.mjs): its id, and the
 * message it forks at, if any. Null for a turn that resumes or starts a session.
 * @param {any} state @returns {{ id: string|null, uuid: string|null }|null}
 */
export function forkOf(state) {
  const f = state?.fork ?? state?.forkFrom ?? null;
  const id = f?.claudeSessionId ?? f?.sdkSessionId ?? null;
  return id ? { id, uuid: f?.uuid ?? null } : null;
}
