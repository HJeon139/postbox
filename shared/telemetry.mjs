// The telemetry gate (designs/telemetry-persona.md, R16): what may leave Postbox in a report, decided without a model.
//   1. labelsOf: the classifier’s answer is enums for the refs it was given, nothing else. A label with anything else
//      becomes “unlabeled”: a bad answer costs a label, never a leak.
//   2. Postbox builds the bytes itself from what passed (server/telemetry-report.mjs, shared/telemetry-bytes.mjs).
//   3. finalCheck: every field of the bytes, last. A string must be Postbox’s vocabulary (shared/telemetry-vocab.mjs) or
//      a Postbox ref or id, a number a number, and no field may be one the schema doesn’t name. Nothing is stripped or
//      rewritten to pass: a value is in the vocabulary, or the save is refused, naming the field and never its value.

import {
  AREAS,
  ATTRIBUTIONS,
  BACKENDS,
  BLOCK_TYPES,
  BOILERPLATE_IDS,
  BUCKETS,
  CONFIDENCE,
  COSTS,
  DURATIONS,
  EFFORTS,
  EMOJIS,
  ENDED,
  GAP_KINDS,
  GAP_REASONS,
  INPUTS,
  MAST,
  MODELS,
  MODES,
  OUTCOMES,
  TOOL_CLASSES,
  TOOL_IDS,
  UNLABELED_REASONS,
  WOKE,
} from './telemetry-vocab.mjs';

/** At most this many items are labeled in one report; the rest are unlabeled (R3). */
export const MAX_LABELS = 60;
export const UNLABELED = 'unlabeled';
/** At most this many failures proposed in a UAT run’s report (R13). */
export const MAX_PROPOSED = 10;

const LABEL_KEYS = new Set(['on', 'mast', 'area', 'attribution', 'turn', 'confidence']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The classifier’s labels, checked (rule 1): one per ref it was asked about, in that order, each its enums and, for its
 * earliest decisive turn, one of the refs its finding names; else unlabeled, with why. In a UAT run it may also propose
 * failures nothing pointed at, with a turn among the room’s; those pass the same way.
 * @param {any} answer  the classifier’s parsed answer: { labels: [...], proposed?: [...] }, or null when there was none
 * @param {{ asked: { ref: string, refs: string[] }[], sent: Set<string>, turns: Set<string>, failed?: string|null, proposals?: boolean }} given
 *   asked: each ref to label, with the refs its finding names; sent: those that went to the classifier (the rest were
 *   over budget); turns: the room’s turn refs; failed: why there was no answer (failed-call, no-classifier)
 * @returns {{ labels: any[], proposed: any[], unlabeled: number }}
 */
export function labelsOf(answer, { asked, sent, turns, failed = null, proposals = false }) {
  const byRef = new Map();
  for (const l of Array.isArray(answer?.labels) ? answer.labels : []) if (isObj(l) && typeof l.on === 'string' && !byRef.has(l.on)) byRef.set(l.on, l);
  const fine = (l, named) =>
    isObj(l) &&
    Object.keys(l).every((k) => LABEL_KEYS.has(k)) &&
    MAST.includes(l.mast) &&
    AREAS.includes(l.area) &&
    ATTRIBUTIONS.includes(l.attribution) &&
    CONFIDENCE.includes(l.confidence) &&
    (l.turn === undefined || l.turn === null || (typeof l.turn === 'string' && named.has(l.turn)));
  const pick = (l) => ({ mast: l.mast, area: l.area, attribution: l.attribution, confidence: l.confidence, ...(l.turn ? { turn: l.turn } : {}) });
  const labels = asked.map(({ ref: on, refs }, i) => {
    const why = i >= MAX_LABELS || !sent.has(on) ? 'over-budget' : (failed ?? (fine(byRef.get(on), new Set(refs)) ? null : 'rejected'));
    return why ? { on, label: UNLABELED, reason: why } : { on, ...pick(byRef.get(on)) };
  });
  const proposed = proposals
    ? (Array.isArray(answer?.proposed) ? answer.proposed : [])
        .slice(0, MAX_PROPOSED)
        .filter((l) => fine({ ...l, on: undefined }, turns))
        .map(pick)
    : [];
  return { labels, proposed, unlabeled: labels.filter((l) => l.label === UNLABELED).length };
}

// ── Rule 3: the final check ──────────────────────────────────────────────────────────────

const en = (list) => (v) => list.includes(v);
const re = (pattern) => (v) => typeof v === 'string' && pattern.test(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e13;
const bool = (v) => typeof v === 'boolean';
const n = en(BUCKETS);
const ms = en(DURATIONS);
const usd = en(COSTS);
/** Refs are looked up in the set this report issued, not matched by pattern (R16): the spec names the kind. */
const T = 'ref:t';
const ITEM = 'ref:i';
const AGENT = (v) => BOILERPLATE_IDS.includes(v) || re(/^agent-\d{1,3}$/)(v);

/** The schema of a report’s bytes: each field’s check, by name; a list’s by its item; `*` for a map’s values. */
const obj = (fields) => ({ fields });
const list = (item) => ({ item });
const map = (key, value) => ({ key, value });
/** Postbox’s ids and formats, each checked where it belongs. */
const SCHEMA = obj({
  schema: en(['postbox-telemetry-2']),
  id: re(/^rep_[A-Za-z0-9]{1,16}$/),
  postbox: obj({ version: 'version', commit: 'commit' }),
  recording: obj({ day: re(/^\d{4}-\d{2}-\d{2}$/), lengthMs: ms, history: bool }),
  classifier: obj({ called: bool, costUsd: usd }),
  room: obj(
    Object.fromEntries([
      ['kind', en(['dm', 'room'])],
      ...['agents', 'personMessages', 'turns', 'sideThreads', 'topicThreads', 'wakeChains', 'longestWakeChain', 'hopConfirms', 'compactions'].map((k) => [
        k,
        n,
      ]),
      ['initiativeEntropy', num],
    ]),
  ),
  agents: list(
    obj({
      id: AGENT,
      backend: en(BACKENDS),
      model: en(MODELS),
      effort: en(EFFORTS),
      permissionMode: en(MODES),
      tools: list(en(TOOL_IDS)),
      hostSetup: bool,
      mcpServers: n,
    }),
  ),
  turns: list(
    obj({
      ref: T,
      agent: AGENT,
      woke: en(WOKE),
      recorded: bool,
      ended: en(ENDED),
      tools: map(en(TOOL_CLASSES), n),
      wallMs: ms,
      firstOutputMs: ms,
      costUsd: usd,
      ...Object.fromEntries(['tokensIn', 'tokensOut', 'toolErrors', 'refusals', 'loops', 'tokensAfterLoop', 'subagents', 'jobs'].map((k) => [k, n])),
    }),
  ),
  prompts: list(obj({ turn: T, tool: en(TOOL_CLASSES), mode: en(MODES), outcome: en(OUTCOMES), waitMs: ms })),
  blocks: list(obj({ ref: ITEM, type: en(BLOCK_TYPES), revisions: n, answered: bool, answerMs: ms, versions: n, checkFailures: n })),
  work: obj({ files: n, lines: n, commands: n, commits: n, pushes: n }),
  gaps: list(obj({ kind: en(GAP_KINDS), turn: T, check: 'check', agent: AGENT, reason: en(GAP_REASONS) })),
  checks: obj({
    found: list(obj({ ref: 'ref:c', check: 'check', issue: num, count: n, refs: list('ref:ti') })),
    notRun: list(obj({ check: 'check', missing: list(en(INPUTS)) })),
  }),
  reactions: list(obj({ ref: 'ref:r', emoji: en(EMOJIS), on: ITEM, detectMs: ms })),
  labels: list(
    obj({
      on: 'ref:cr',
      label: en(['unlabeled']),
      reason: en(UNLABELED_REASONS),
      mast: en(MAST),
      area: en(AREAS),
      attribution: en(ATTRIBUTIONS),
      turn: 'ref:ti',
      confidence: en(CONFIDENCE),
    }),
  ),
  proposed: list(obj({ mast: en(MAST), area: en(AREAS), attribution: en(ATTRIBUTIONS), turn: T, confidence: en(CONFIDENCE) })),
});

/**
 * Every field of a report that isn’t Postbox’s vocabulary, a ref, an id or a number where the schema says, as paths:
 * empty when the report may be saved. Never the values.
 * @param {any} report
 * @param {{ checkIds: string[], build?: { version?: string|null, commit?: string|null }, refs: Iterable<string>, uat?: boolean }} vocab  the
 *   check ids Postbox has (server/room-checks.mjs); its own version and commit, since a report names this build and
 *   nothing else in those fields; the refs it issued for this report; and whether the runner started this as a UAT run
 * @returns {string[]}
 */
export function finalCheck(report, { checkIds, build = {}, refs, uat = false }) {
  /** @type {string[]} */
  // Proposals are a UAT run’s only, as the runner starts it; a live room’s report holds none (R13, R16).
  const out = !uat && report?.proposed?.length ? ['proposed'] : [];
  const issued = new Set(refs);
  const check = (spec, v, path) => {
    if (spec === 'check') return checkIds.includes(v) || out.push(path);
    if (typeof spec === 'string' && spec.startsWith('ref:')) return (typeof v === 'string' && issued.has(v) && spec.slice(4).includes(v[0])) || out.push(path);
    if (spec === 'version' || spec === 'commit') return (typeof v === 'string' && v === build[spec]) || out.push(path);
    if (typeof spec === 'function') return spec(v) || out.push(path);
    if (spec.item) {
      if (!Array.isArray(v)) return out.push(path);
      for (const [i, x] of v.entries()) check(spec.item, x, `${path}[${i}]`);
      return;
    }
    if (spec.key) {
      if (!isObj(v)) return out.push(path);
      for (const [k, x] of Object.entries(v)) {
        if (!spec.key(k)) out.push(`${path} (a key)`);
        check(spec.value, x, `${path}.${k}`);
      }
      return;
    }
    if (!isObj(v)) return out.push(path);
    for (const [k, x] of Object.entries(v)) {
      if (!Object.hasOwn(spec.fields, k)) out.push(`${path ? `${path}.` : ''}${k} (not a field)`);
      else check(spec.fields[k], x, path ? `${path}.${k}` : k);
    }
  };
  check(SCHEMA, report, '');
  return out;
}
