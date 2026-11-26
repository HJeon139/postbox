// Asks shown while their agent’s turn still runs (#1746’s related defect): on main a block that asks counts as “needs
// you” only once its turn ends (server/turn-needs.mjs), so a turn that goes on working leaves the top bar saying
// nothing needs you beside an open form. Read from a run’s event history: when the block was added, when a session
// event first carried it as the session’s need, when it was answered, and when the turn ended.

import { ASKING } from '../../shared/catalog.mjs';
import { clip } from './trigger-facts.mjs';

/** When a session named an ask as its need, against its turn’s end. @param {number|null} countedAt @param {number} end @returns {'mid-turn'|'at-turn-end'|'never'} */
function countedWhen(countedAt, end) {
  if (countedAt === null) return 'never';
  return countedAt < end ? 'mid-turn' : 'at-turn-end';
}

/**
 * Each asking block an agent showed, which it does in a turn. `turnMs` is how long the turn went on after it; `uncountedMs` is
 * how long it was on screen in that turn before the session named it as its need, or the person answered it anyway.
 * Both run to the last recorded time for a turn still open when the records end.
 * @param {{ events?: any[] }} f
 * @returns {{ itemId: string, handle: string, title: string, shownAt: number, turnMs: number, uncountedMs: number, counted: 'mid-turn'|'at-turn-end'|'never' }[]}
 */
export function midTurnAsks(f) {
  /** @type {Map<string, boolean>} whether each session is in a turn: started thinking, and finishedAt still clear */
  const inTurn = new Map();
  /** @type {Map<string, any>} */
  const asks = new Map();
  let last = 0;
  for (const e of f.events ?? []) {
    const d = e?.data;
    if (e?.type === 'session' && d?.id) {
      last = Math.max(last, d.updatedAt ?? 0);
      const now = d.finishedAt === null && (inTurn.get(d.id) === true || d.state === 'think');
      inTurn.set(d.id, now);
      for (const a of asks.values()) {
        if (a.sessionId !== d.id || a.endedAt !== null) continue;
        if (a.countedAt === null && d.needs?.itemId === a.itemId) a.countedAt = last;
        if (!now) a.endedAt = last;
      }
    } else if (e?.type === 'item.add' && d?.item) {
      const it = d.item;
      last = Math.max(last, it.variant === 'schedule' ? 0 : (it.at ?? 0));
      if (it.kind === 'block' && ASKING.has(it.block?.type))
        asks.set(it.id, {
          itemId: it.id,
          sessionId: it.sessionId,
          handle: it.handle,
          block: it.block,
          shownAt: it.at,
          countedAt: null,
          answeredAt: null,
          endedAt: null,
        });
    } else if (e?.type === 'item.patch' && d?.patch?.answered === true && asks.has(d.id)) {
      asks.get(d.id).answeredAt = d.patch.answer?.at ?? last;
    }
  }
  return [...asks.values()].map((a) => {
    const end = a.endedAt ?? last;
    const seen = Math.min(a.countedAt ?? end, a.answeredAt ?? end, end);
    return {
      itemId: a.itemId,
      handle: a.handle,
      title: clip(a.block.title ?? a.block.prompt ?? a.block.id ?? '', 60),
      shownAt: a.shownAt,
      turnMs: Math.max(0, end - a.shownAt),
      uncountedMs: Math.max(0, seen - a.shownAt),
      counted: countedWhen(a.countedAt, end),
    };
  });
}
