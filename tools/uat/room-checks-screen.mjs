// What the conversation shows while and after agents work: a review block’s table, a progress block left running, the
// working row, and the agents’ model. Part of tools/uat/room-checks.mjs’s CHECKS, kept apart for size.

import { clip } from '../../shared/text.mjs';
import { itemsOf } from './room-items.mjs';

export const SCREEN_CHECKS = [
  {
    id: 'review-table-raw',
    inputs: ['ui', 'state', 'threads'],
    issue: 62,
    run: (f) =>
      itemsOf(f)
        .filter(
          (it) =>
            it.kind === 'block' &&
            it.valid &&
            it.block.type === 'review' &&
            it.block.format === 'markdown' &&
            /^\s*\|.*\|\s*\n\s*\|\s*:?-{3,}/m.test(it.block.content ?? '') &&
            // What’s on screen decides: since #62, a table renders as a table. Without a reading, assume it did.
            (f.ui?.reviewRawRows?.[it.id] ?? 0) > 0,
        )
        .map((it) => ({
          key: it.id,
          title: 'A review block’s Markdown table shows as raw pipes',
          evidence: `“${it.block.title ?? 'review'}” has a table, and ${f.ui.reviewRawRows[it.id]} of its rows show as raw pipes on screen.`,
        })),
  },
  {
    id: 'stale-progress',
    inputs: ['state', 'threads'],
    issue: 58,
    run: (f) =>
      itemsOf(f)
        .filter((it) => it.kind === 'block' && it.valid && it.block.type === 'progress' && (it.block.steps ?? []).some((s) => s.state === 'running'))
        .filter((it) => {
          const se = f.state.sessions[it.sessionId];
          return se && !['think', 'gen', 'tool'].includes(se.state);
        })
        .map((it) => ({
          key: it.id,
          title: 'A progress block still says “running” after its agent stopped',
          evidence: `“${it.block.title ?? 'progress'}”: ${(it.block.steps ?? [])
            .filter((s) => s.state === 'running')
            .map((s) => s.label)
            .join(', ')}.`,
        })),
  },
  {
    id: 'silent-while-working',
    inputs: ['samples'],
    issue: 68,
    run: (f) => {
      const silent = (f.samples ?? []).filter((s) => s.busy.length && s.rows === 0).length;
      const busy = (f.samples ?? []).filter((s) => s.busy.length).length;
      return busy >= 4 && silent / busy > 0.8
        ? [
            {
              title: 'While agents think or call tools, nothing on screen says what they’re doing',
              evidence: `In ${silent} of ${busy} samples taken while an agent worked, there was no working row or glimpse.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'model-not-shown',
    inputs: ['ui', 'state'],
    issue: 60,
    run: (f) =>
      // Claude’s families, or any model a persona in the run names: a Kiro persona can run gpt-5.6-terra (#117).
      f.ui?.headerText &&
      !/opus|sonnet|haiku|fable/i.test(f.ui.headerText) &&
      !Object.values(f.state?.personas ?? {}).some((p) => p.model && p.model !== 'mock' && f.ui.headerText.includes(p.model))
        ? [{ title: 'The UI doesn’t show which model an agent runs', evidence: `Agents section: “${clip(f.ui.headerText, 120)}”.` }]
        : [],
  },
];
