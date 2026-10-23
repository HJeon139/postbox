// M1’s exit check (#64): what a turn’s reply calls for, and whether it used the right block. prose-instead-of-block
// in tools/uat/checks.mjs reads it, and counts the run with blockUseTally.

// ── M1’s exit check: did a reply that called for a block use the right one? (#64) ──────────────────────
// What a turn calls for, from what the person asked and what the agent did, as the agent guide maps them:
// - a long job → progress: the turn showed a progress block, or did a job of several steps (10 or more tool calls,
//   or 2 minutes or more with 3 or more). Writing alone isn’t a job: a 2-minute turn that only writes a doc isn’t one.
// - a draft → review: the turn showed a review block, or the prose itself holds a draft (8 or more lines that don’t
//   just point at a block) when the person asked for something to approve, or the agent asks them to approve it. A
//   report, an explanation or a result isn’t a draft, however long.
// - options → choice: two or more list items with a question asking the person to pick (which, choose, prefer…)
//   that isn’t itself a list item.
// - questions → form or choice: three or more questions to the person.
// Practice questions (inside <details>, or under a Practice or Exercise heading) ask nothing of the person, and a
// reply to Postbox’s own lint message isn’t a reply to the person. A turn is right only if everything it called for
// has one of its expected blocks. Tuned on the first wave 2 runs (uat-runs/2026-10-22T19-07-51-*): a long job with a
// progress block and a table had read as a missed draft.
const BLOCK_USE = {
  options: { blocks: ['choice'], words: 'options' },
  questions: { blocks: ['form', 'choice'], words: 'questions' },
  draft: { blocks: ['review'], words: 'a draft' },
  long: { blocks: ['progress'], words: 'a long job' },
  decision: { blocks: ['confirm'], words: 'a decision' },
};
/** @type {Record<string, keyof typeof BLOCK_USE>} */
const SERVES = { choice: 'options', form: 'questions', review: 'draft', progress: 'long', confirm: 'decision' };

export const LONG_TURN_MS = 120_000;
export const LONG_TURN_TOOLS = 10;
const LONG_TURN_MIN_TOOLS = 3;
const DRAFT_LINES = 8;
// What the person asked for, or what the agent asks of them, when a reply is something to approve. The person
// saying “approved” is an answer, not a request.
const ASKS_FOR_DRAFT =
  /\b(draft|(for|to) (my |your )?(approv\w*|sign[- ]?off|review)|announcement|newsletter|e-?mail|letter|proposal|press release|release notes|blog post|write[- ]?up)\b/i;
const ASKS_TO_APPROVE =
  /\b(approv\w*|sign[- ]?off|ready to (send|post|publish|go out)|before (it goes out|you send|sending|posting|publishing)|look(s)? good to you)\b/i;
// A reply that points at a block rather than holding the draft itself.
const POINTS_AT_BLOCK = /\b(review block|in the review|up for (your )?review|ready for (you to|your) review|shows what changed|in the block|above)\b/i;
const PICK = /\b(which|pick|choose|prefer|rather|would you like|want me to|should (i|we)|go with)\b/i;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*])\s+\S/;

/** The lines of a reply the person is asked to act on: no practice questions, no hidden answers. */
function askingLines(text) {
  const out = [];
  let practice = false;
  for (const line of String(text ?? '')
    .replace(/<details>[\s\S]*?<\/details>/gi, '')
    .split('\n')) {
    if (/^\s*(#+\s*|\*\*)?(practice|exercise|try (it|this)|quiz)\b/i.test(line)) practice = true;
    else if (/^\s*#+\s/.test(line)) practice = false;
    if (!practice) out.push(line);
  }
  return out;
}

/** What a turn’s reply calls for, by the rules above. */
export function callsFor({ text = '', types = [], person = '', ms = 0, tools = 0, lint = false }) {
  /** @type {Set<keyof typeof BLOCK_USE>} */
  const calls = new Set(types.flatMap((t) => (SERVES[t] ? [SERVES[t]] : [])));
  if (lint) return calls;
  const lines = askingLines(text);
  const tail = lines.slice(-14);
  const prose = lines.filter((l) => l.trim());
  const questions =
    tail
      .filter((l) => !LIST_ITEM.test(l))
      .join('\n')
      .match(/\?/g)?.length ?? 0;
  const items = tail.filter((l) => LIST_ITEM.test(l)).length;
  if (questions >= 3) calls.add('questions');
  else if (items >= 2 && tail.some((l) => !LIST_ITEM.test(l) && l.includes('?') && PICK.test(l))) calls.add('options');
  const approval = ASKS_FOR_DRAFT.test(person) || ASKS_TO_APPROVE.test(tail.join('\n'));
  if (approval && prose.length >= DRAFT_LINES && !POINTS_AT_BLOCK.test(text)) calls.add('draft');
  if (tools >= LONG_TURN_TOOLS || (ms >= LONG_TURN_MS && tools >= LONG_TURN_MIN_TOOLS)) calls.add('long');
  return calls;
}

export function blockUseTally() {
  let right = 0;
  let wrong = 0;
  /** @type {Record<string, number>} */
  const used = {};
  /** @type {Record<string, number>} */
  const missed = {};
  const count = (o, k) => {
    o[k] = (o[k] ?? 0) + 1;
  };
  const list = (o) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  return {
    /** @param {any[]} items  the turn’s items  @param {string[]} types  its valid blocks  @param {string} person  what the person last wrote */
    add(items, types, person) {
      const text = items
        .filter((it) => it.kind === 'agent')
        .map((it) => it.text ?? '')
        .join('\n');
      // How long it ran: from its first item to its last, or its tool steps’ own times, whichever is longer. A turn
      // that writes only at the end has one reply item, made at its first step, so the items alone can read as 0.
      const at = items.map((it) => it.at).filter((n) => typeof n === 'number');
      // Tool calls: not a thought, or a subagent’s narration (#73).
      const steps = items.flatMap((it) => it.activity?.steps ?? []).filter((st) => st.kind !== 'thought' && st.kind !== 'said');
      const ms = Math.max(
        at.length ? Math.max(...at) - Math.min(...at) : 0,
        steps.reduce((a, st) => a + (Number(st.ms) || 0), 0),
      );
      const calls = callsFor({ text, types, person, ms, tools: steps.length, lint: items.some((it) => it.lintReply) });
      if (!calls.size) return;
      const lacking = [...calls].filter((c) => !BLOCK_USE[c].blocks.some((b) => types.includes(b)));
      if (lacking.length) {
        wrong++;
        for (const c of lacking) count(missed, BLOCK_USE[c].words);
      } else {
        right++;
        for (const t of new Set(types)) if (SERVES[t]) count(used, t);
      }
    },
    /**
     * The run’s counts, as information rather than a defect: no issue, so “Known issues caught again” doesn’t list
     * it, and a verdict of its own, so the runner neither verifies nor files it. Its key carries the counts, so a
     * live run logs each new total, and the last is the run’s.
     */
    finding() {
      const called = right + wrong;
      if (!called) return null;
      return {
        key: `block-use:${right}-of-${called}`,
        issue: null,
        title: `M1 exit check: ${right} of ${called} replies that called for a block used the right one`,
        evidence: `${right} right${right ? ` (${list(used)})` : ''}; ${wrong} without the block they called for${wrong ? ` (${list(missed)})` : ''}.`,
        verdict: 'measurement',
        note: 'Not a defect: the block counts for M1’s exit check (#64).',
        counts: { right, wrong, byType: used, missed },
      };
    },
  };
}
