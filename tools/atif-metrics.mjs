// Tokens and cost in an ATIF trajectory (tools/atif.mjs), from the work ledger’s turn entries (server/ledger-end.mjs):
// a turn’s figures go on its first step, whether a reply or a block it showed, and final_metrics sums the session’s
// turns from the ledger, not from the steps, so a turn no step carries is still counted. A figure the backend didn’t
// report is left out, never made up: a total only some turns reported is a partial sum in extra, with how many did.

/** A turn’s tokens and cost as ATIF metrics, or null when its backend reported neither. @param {any} turn */
export function metricsOf(turn) {
  const t = turn?.tokens;
  const cost = typeof turn?.costUsd === 'number' ? turn.costUsd : null;
  if (!t && cost === null) return null;
  return {
    ...(t
      ? { prompt_tokens: (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0), completion_tokens: t.output ?? 0, cached_tokens: t.cacheRead ?? 0 }
      : {}),
    ...(cost === null ? {} : { cost_usd: cost }),
    ...(t ? { extra: { cache_write_tokens: t.cacheWrite ?? 0 } } : {}),
  };
}

/**
 * Gives each turn’s figures to its first step only, so the steps’ sum is the turns’: call it for each agent step in
 * order. @param {Map<string, any>} turns  the session’s ledger turns, by id
 */
export function meter(turns) {
  const metered = new Set();
  return {
    metered,
    /** @param {string|null|undefined} turnId */
    take(turnId) {
      if (!turnId || metered.has(turnId) || !turns.has(turnId)) return null;
      metered.add(turnId);
      return metricsOf(turns.get(turnId));
    },
  };
}

/** Each final total and the turn metric it sums. */
const FINAL = [
  ['total_prompt_tokens', 'prompt_tokens'],
  ['total_completion_tokens', 'completion_tokens'],
  ['total_cached_tokens', 'cached_tokens'],
  ['total_cost_usd', 'cost_usd'],
];

/**
 * The session’s totals over every turn the ledger has for it. A total is given only when every turn reported it; else
 * the sum of those that did is in extra.partial. A turn with figures that no step carries is listed in
 * extra.unattached_turns.
 * @param {Map<string, any>} turns  the session’s ledger turns @param {Set<string>} metered  the turns a step carries @param {number} steps
 */
export function finalMetrics(turns, metered, steps) {
  const all = [...turns.values()].map((t) => ({ id: t.id, m: metricsOf(t) }));
  const totals = {};
  const partial = {};
  for (const [total, k] of FINAL) {
    const have = all.filter((x) => typeof x.m?.[k] === 'number');
    if (!have.length) continue;
    const sum = have.reduce((n, x) => n + x.m[k], 0);
    if (have.length === all.length) totals[total] = sum;
    else partial[total] = { sum, turns_reported: have.length, turns_unreported: all.length - have.length };
  }
  const unattached = all.filter((x) => x.m && !metered.has(x.id)).map((x) => ({ turn_id: x.id, metrics: x.m }));
  const extra = {
    ...(Object.keys(partial).length ? { partial } : {}),
    ...(unattached.length ? { unattached_turns: unattached } : {}),
  };
  return { ...totals, total_steps: steps, ...(Object.keys(extra).length ? { extra } : {}) };
}
