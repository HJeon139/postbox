// What agents wrote: a question or a draft asked in prose rather than a block, terms the lint made them define, and a
// diagram error they weren’t told of. Part of tools/uat/room-checks.mjs’s CHECKS, kept apart for size.

import { clip } from '../../shared/text.mjs';
import { asksInProse, blockUseTally } from './block-use.mjs';
import { itemsOf } from './room-items.mjs';

export const REPLY_CHECKS = [
  {
    // Besides a finding per reply that should have been a block, it counts M1’s exit check (#64) over the run: the
    // replies that called for a block, and the ones that used the right one. See tools/uat/block-use.mjs.
    id: 'prose-instead-of-block',
    inputs: ['state', 'threads'],
    issue: 63,
    run: (f) => {
      const items = itemsOf(f);
      const turns = new Map();
      /** @type {Map<string, string>} */
      const person = new Map(); // a turn → what the person last wrote before it, in its conversation
      /** @type {Map<string, string>} */
      const said = new Map();
      for (const it of items) {
        if (it.kind === 'user') said.set(it.threadId, it.text ?? '');
        if (!it.turnId || (it.kind !== 'agent' && it.kind !== 'block')) continue;
        if (!turns.has(it.turnId)) person.set(it.turnId, said.get(it.threadId) ?? '');
        turns.set(it.turnId, [...(turns.get(it.turnId) ?? []), it]);
      }
      const out = [];
      const tally = blockUseTally();
      for (const [turnId, list] of turns) {
        const types = list.filter((it) => it.kind === 'block' && it.valid).map((it) => it.block.type);
        const text = list
          .filter((it) => it.kind === 'agent')
          .map((it) => it.text ?? '')
          .join('\n');
        const tail = text.split('\n').slice(-14).join('\n');
        tally.add(list, types, person.get(turnId) ?? '');
        if (types.some((t) => ['choice', 'form', 'review', 'confirm'].includes(t))) continue;
        const asks = asksInProse(text);
        if (asks)
          out.push({
            key: list[0].id,
            title:
              asks === 'draft'
                ? 'A draft to approve was sent as prose, not a review block'
                : 'Questions or options were asked in prose, not a form or choice block',
            evidence: `@${list[0].handle}: “${clip(tail, 200)}”`,
          });
      }
      const counts = tally.finding();
      if (counts) out.push(counts);
      return out;
    },
  },
  {
    id: 'lint-on-person-term',
    inputs: ['state', 'threads'],
    issue: 55,
    run: (f) => {
      const items = itemsOf(f);
      const said = items
        .filter((it) => it.kind === 'user')
        .map((it) => it.text ?? '')
        .join('\n')
        .toLowerCase();
      // A term counts only when its agent defined it during a lint turn: agents define terms on their own too.
      const inLintTurn = (t, g) => {
        const mine = items.filter((it) => it.threadId === t && it.kind === 'agent' && it.handle === g.by && it.at <= g.at);
        return mine.at(-1)?.lintReply === true;
      };
      const hits = f.threads.flatMap((t) =>
        Object.values(f.state.glossary?.[t] ?? {})
          .filter((g) => said.includes(String(g.term).toLowerCase()) && inLintTurn(t, g))
          .map((g) => g.term),
      );
      return hits.length
        ? [{ title: 'The term lint made an agent define a term the person introduced', evidence: `Defined after a lint turn: ${hits.join(', ')}.` }]
        : [];
    },
  },
  {
    id: 'topic-relints-parent-term',
    inputs: ['state', 'threads'],
    issue: 56,
    run: (f) => {
      const out = [];
      for (const t of f.threads) {
        const th = f.state.threads[t];
        if (th?.kind !== 'topic') continue;
        const parent = new Set(Object.keys(f.state.glossary?.[th.parentId] ?? {}));
        const again = Object.values(f.state.glossary?.[t] ?? {}).filter((g) => parent.has(g.key));
        if (again.length)
          out.push({ key: t, title: 'A topic thread re-defined terms its conversation already had', evidence: again.map((g) => g.term).join(', ') });
      }
      return out;
    },
  },
  {
    id: 'diagram-error-not-fed-back',
    inputs: ['console'],
    issue: 46,
    run: (f) => {
      const errors = (f.console ?? []).filter((l) => /Diagram: /.test(l));
      return errors.length ? [{ title: 'A diagram failed to draw, and the agent wasn’t told', evidence: clip(errors[0], 200) }] : [];
    },
  },
];
