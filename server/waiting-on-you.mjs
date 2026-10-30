// What’s waiting on the person, as the UAT runner and its report show it. Moved from server/room-checks.mjs, which
// re-exports it, to keep that file to its size.

import { ASKING } from '../shared/catalog.mjs';
import { clip } from '../shared/text.mjs';

/**
 * What’s waiting on the person in these threads, as the “needs you” count sees it: a block that asks (choice,
 * form, confirm, review) and isn’t answered, an open wake request or proposal, and whatever a session says it
 * needs (a permission card, a failed turn to retry). The runner shows it to the tester every step, and doesn’t
 * move on while it’s there, so a run answers what an agent asked instead of leaving it behind.
 * @param {any} state  @param {string[]} threads
 * @returns {{ itemId: string|null, threadId: string, what: string }[]}
 */
export function waitingOnYou(state, threads) {
  /** @type {Map<string, { itemId: string|null, threadId: string, what: string }>} */
  const out = new Map();
  for (const t of threads)
    for (const it of state.items?.[t] ?? []) {
      const by = it.handle ? `@${it.handle}’s ` : '';
      if (it.kind === 'block' && it.valid !== false && ASKING.has(it.block?.type) && !it.answered)
        out.set(it.id, {
          itemId: it.id,
          threadId: t,
          what: `${by}${it.block.type} “${clip(it.block.title ?? it.block.prompt ?? '', 80)}”${it.block.revision ? `, revision ${it.block.revision}` : ''}`,
        });
      else if ((it.kind === 'hop' || it.kind === 'proposal') && it.status === 'open')
        out.set(it.id, { itemId: it.id, threadId: t, what: it.kind === 'hop' ? 'a wake request' : `${by}proposal for a new teammate` });
    }
  for (const t of threads)
    for (const id of state.threads?.[t]?.members ?? []) {
      const se = state.sessions?.[id];
      if (!se?.needs) continue;
      const key = se.needs.itemId ?? `needs:${se.id}`;
      if (!out.has(key)) out.set(key, { itemId: se.needs.itemId ?? null, threadId: se.threadId ?? t, what: clip(se.needs.text ?? se.needs.kind, 120) });
    }
  return [...out.values()];
}
