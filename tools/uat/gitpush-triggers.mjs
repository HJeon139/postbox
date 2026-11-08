// The gitpush scenario’s triggers (#305, #296, tests/uat/e2e/scenarios/gitpush.md): an agent commits and pushes over
// and over to the run’s throwaway remote (`- seed: git-remote`, tools/uat/git-remote.mjs). tools/uat/triggers.mjs
// adds them to TRIGGERS. Each reads what landed from the remote’s own record of every ref update (facts.remote, kept
// in remote.json), never from what an agent says it pushed; the cards from the state; and each call’s permission mode
// from the agents’ recorded streams.

import { bashCalls } from './allowonce-triggers.mjs';
import { clip, itemsOf } from './trigger-facts.mjs';

/** Pushes, and gh PR writes, as a command names them. */
const PUSH = /(?:^|[;&|]\s*|\s)git\s+(?:-\S+\s+)*push\b/;
const PR_WRITE = /(?:^|[;&|]\s*|\s)gh\s+pr\s+(?:create|edit|comment|merge)\b/;
const isWrite = (command) => PUSH.test(command) || PR_WRITE.test(command);

/** The cards that came up for a push or a PR write: permission cards and refusal cards, oldest first. */
const writeCards = (f) =>
  itemsOf(f)
    .filter((it) => (it.kind === 'permission' || it.kind === 'denial') && it.tool === 'Bash' && isWrite(String(it.detail ?? '')))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

const pushes = (f) => f.remote?.pushes ?? [];
const lastSample = (f) => f.remote?.samples?.at(-1) ?? null;

/** How many pushes a scale phase needs, and how many an Auto phase needs with no card. */
export const SCALE_PUSHES = 20;
export const AUTO_PUSHES = 10;

export const GIT_PUSH_TRIGGERS = {
  'push-card-landed': {
    issue: 296,
    says: 'a push came to a permission card, the person allowed it, and the remote then took a push: by its own record, not the agent’s word',
    recorded: (f) => !!f.state && !!f.remote,
    run: (f) =>
      writeCards(f)
        .filter((c) => c.kind === 'permission' && PUSH.test(c.detail) && String(c.status ?? '').startsWith('allowed'))
        .filter((c) => pushes(f).some((p) => p.at >= Math.floor((c.answeredAt ?? Infinity) / 1000) * 1000))
        .slice(0, 1)
        .map((c) => ({ at: c.answeredAt, evidence: `@${c.handle}’s \`${clip(c.detail, 80)}\` was ${c.status}, and the remote took a push after it.` })),
  },
  'always-allow-no-card': {
    issue: 296,
    says: 'after Always allow on a push’s card, the remote took three or more pushes and no push came to a card again',
    recorded: (f) => !!f.state && !!f.remote,
    run: (f) => {
      const cards = writeCards(f).filter((c) => PUSH.test(c.detail));
      const always = cards.find((c) => c.status === 'allowed-always');
      if (!always) return [];
      const after = pushes(f).filter((p) => p.at > (always.answeredAt ?? Infinity));
      const again = cards.filter((c) => (c.at ?? 0) > always.answeredAt);
      if (after.length < 3 || again.length) return [];
      return [{ at: after[2].at, evidence: `After Always allow on \`${clip(always.detail, 80)}\`, the remote took ${after.length} pushes with no card.` }];
    },
  },
  'pushes-at-scale': {
    issue: 305,
    says: `the remote took ${SCALE_PUSHES} or more pushes, and the work ledger has a push entry for each one`,
    recorded: (f) => !!f.remote,
    run: (f) => {
      const n = pushes(f).length;
      const s = lastSample(f);
      if (n < SCALE_PUSHES || !s || s.ledgerPushes < n) return [];
      return [
        {
          at: pushes(f)[SCALE_PUSHES - 1].at,
          evidence: `${n} pushes on the remote; the ledger has ${s.ledgerPushes} push entries of ${s.entries} (${s.ledgerBytes} bytes), and the state is ${s.stateBytes} bytes.`,
        },
      ];
    },
  },
  'auto-writes-no-card': {
    issue: 305,
    says: `in Auto, ${AUTO_PUSHES} or more pushes landed, with a PR write among the calls, and none of those calls came to a card`,
    recorded: (f) => !!f.state && !!f.remote && Array.isArray(f.streams),
    run: (f) => {
      const auto = bashCalls(f.streams).filter((k) => k.mode === 'auto' && isWrite(k.command));
      if (!auto.length || !auto.some((k) => PR_WRITE.test(k.command))) return [];
      const from = Math.min(...auto.map((k) => k.started ?? Infinity));
      const landed = pushes(f).filter((p) => p.at >= Math.floor(from / 1000) * 1000);
      const ids = new Set(auto.map((k) => k.id));
      const carded = writeCards(f).filter((c) => ids.has(c.toolUseId));
      if (landed.length < AUTO_PUSHES || carded.length) return [];
      const prs = auto.filter((k) => PR_WRITE.test(k.command)).length;
      return [
        {
          at: landed[AUTO_PUSHES - 1].at,
          evidence: `In Auto, ${landed.length} pushes landed and ${prs} PR writes ran, with no card for any of ${auto.length} write calls.`,
        },
      ];
    },
  },
};
