// What archived turns add to the Work view's totals (#305, T-14). A turn-archive summary entry (written by
// server/work-archive.mjs) keeps the effort and counts of the turn it replaced, so the totals read the same before and
// after a pass.

/** The effort of archived turns, for one agent or all: what their summaries kept. */
export function archivedEffort(archives, handle) {
  const rows = archives.map((a) => (handle ? a.effort?.byHandle?.[handle] : a.effort)).filter(Boolean);
  const add = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  return {
    turns: add('turns'),
    ms: add('ms'),
    toolCalls: add('toolCalls'),
    costUsd: add('costUsd'),
    tokens: add('tokens'),
    priced: rows.some((r) => r.priced),
  };
}
export const plusEffort = (a, b) => ({
  turns: a.turns + b.turns,
  ms: a.ms + b.ms,
  toolCalls: a.toolCalls + b.toolCalls,
  costUsd: a.costUsd + b.costUsd,
  tokens: a.tokens + b.tokens,
  priced: a.priced || b.priced,
});
/** What archived turns did, from their summaries' counts: shown beside the live lists, never merged into them. */
export function archivedCounts(archives) {
  const add = (k) => archives.reduce((n, a) => n + (a.counts?.[k] ?? 0), 0);
  return {
    turns: archives.length,
    files: add('files'),
    commands: add('commands'),
    failed: add('failed'),
    reads: add('reads'),
    publishes: add('publishes'),
    lines: {
      added: archives.reduce((n, a) => n + (a.counts?.lines?.added ?? 0), 0),
      removed: archives.reduce((n, a) => n + (a.counts?.lines?.removed ?? 0), 0),
    },
  };
}

/**
 * The live totals plus what archived turns kept, for the same scope: effort in all and per agent, and the counts of
 * what they did beside the live lists (never merged into them). Returns the live totals unchanged when nothing in
 * scope is archived.
 * @param {any} live  summarize's totals of the entries in the state
 * @param {any[]} list  the conversation's work entries
 * @param {{ handle?: string | null, turnId?: string | null }} opts
 */
export function withArchived(live, list, { handle = null, turnId = null } = {}) {
  const archives = list.filter((e) => e.kind === 'turn-archive' && (!turnId || e.turnId === turnId) && (!handle || e.effort?.byHandle?.[handle]));
  if (!archives.length) return live;
  const byAgent = live.byAgent.map((a) => ({ ...a }));
  for (const a of archives)
    for (const [h, e] of Object.entries(a.effort?.byHandle ?? {})) {
      if (handle && h !== handle) continue;
      let row = byAgent.find((r) => r.handle === h);
      if (!row)
        byAgent.push(
          (row = { handle: h, turns: 0, ms: 0, toolCalls: 0, costUsd: 0, tokens: 0, commands: 0, failed: 0, written: 0, writtenDel: 0, added: 0, deleted: 0 }),
        );
      row.turns += e.turns;
      row.ms += e.ms;
      row.toolCalls += e.toolCalls;
      row.costUsd += e.costUsd;
      row.tokens += e.tokens;
    }
  byAgent.sort((a, b) => b.added + b.deleted - (a.added + a.deleted) || b.turns - a.turns);
  const counts = archivedCounts(archives);
  return {
    ...live,
    byAgent,
    effort: { ...plusEffort(live.effort, archivedEffort(archives, handle)), written: live.effort.written + counts.lines.added, kept: live.effort.kept },
    archived: counts,
  };
}

/** The turn ids of the archived turns in scope, whose kept entries the live totals still count. @param {any[]} list @param {{ handle?: string | null, turnId?: string | null }} opts */
export function archivedTurnIds(list, { handle = null, turnId = null } = {}) {
  return list.filter((e) => e.kind === 'turn-archive' && (!turnId || e.turnId === turnId) && (!handle || e.effort?.byHandle?.[handle])).map((e) => e.turnId);
}
