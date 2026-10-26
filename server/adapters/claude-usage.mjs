// What a Claude Code turn spent (#295). A result’s total_cost_usd and modelUsage run for the session, across
// --resume, not for the process: three resumed `claude -p` turns of one session (claude 2.1.310, Haiku) reported
// total_cost_usd 0.003123, 0.005951 and 0.008789, and modelUsage input tokens 2, 4 and 6, while each result’s own
// usage was that turn’s. So a turn’s spend is its result’s totals less the session’s totals before the turn, which
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
 * A turn’s own spend: totals less before, when before is the same session’s. A new session (a first turn, a fork)
 * has nothing to subtract.
 * @param {ReturnType<typeof sessionTotals>} totals @param {any} before  the session’s totals when the turn started
 * @returns {{ costUsd: number|null, tokens: Record<string, number>|null }}
 */
export function turnSpend(totals, before) {
  const base = before?.sessionId && before.sessionId === totals.sessionId ? before : null;
  return {
    costUsd: totals.costUsd === null ? null : less(totals.costUsd, base?.costUsd),
    tokens: totals.tokens && Object.fromEntries(Object.entries(totals.tokens).map(([k, v]) => [k, less(v, base?.tokens?.[k])])),
  };
}
