// What a run spent on Claude Code, from the results its sessions report.
//
// A result’s total_cost_usd is its Claude Code session’s running total, not the cost of that one call: a resumed
// session continues from the total its transcript saved, so its first result already carries the earlier turns
// (the Agent SDK’s sdk.d.ts, on total_cost_usd: “read the latest result rather than summing across results”). Every
// recorded run shows it: each agent session’s totals only grow, turn after turn. Agents resume their session every
// turn, and the tester every step, so adding the totals counts every earlier turn again: the longresearch run of
// 24 October added up to $17.64 for its agents, whose two sessions ended at $1.37 and $0.57.

/**
 * A session’s spend after one more result: the most it has reported. A crashed call’s zeroed result lowers nothing.
 * @param {number} spent  @param {any} result
 */
export const sessionTotal = (spent, result) => Math.max(spent, Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : 0);

/**
 * Each agent turn’s cost, in the order the turns started: its result’s total less the most its session had reported
 * before. A forked session (a topic thread) starts from its parent’s total, which counts here as the fork’s first
 * turn: more than it spent, never less.
 * @param {{ handle?: string, started?: number, events: any[] }[]} streams  from readStreams (tools/uat/run-files.mjs)
 * @returns {{ handle: string|undefined, session: string|null, usd: number }[]}
 */
export function turnCosts(streams) {
  /** @type {Map<string, number>} */
  const most = new Map();
  const out = [];
  for (const s of [...(streams ?? [])].sort((a, b) => (a.started ?? 0) - (b.started ?? 0)))
    for (const e of s.events ?? []) {
      if (e?.type !== 'result' || !Number.isFinite(e.total_cost_usd)) continue;
      const session = typeof e.session_id === 'string' ? e.session_id : null;
      const before = session ? (most.get(session) ?? 0) : 0;
      out.push({ handle: s.handle, session, usd: Math.max(0, e.total_cost_usd - before) });
      if (session) most.set(session, sessionTotal(before, e));
    }
  return out;
}

/** What the agents’ turns cost, together. @param {{ events: any[] }[]} streams */
export const agentsSpent = (streams) => turnCosts(streams).reduce((a, t) => a + t.usd, 0);
