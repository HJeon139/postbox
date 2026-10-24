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
  WOKE,
} from './telemetry-vocab.mjs';

/** At most this many items are labeled in one report; the rest are unlabeled (R3). */
export const MAX_LABELS = 60;
export const UNLABELED = 'unlabeled';

const LABEL_KEYS = new Set(['on', 'mast', 'area', 'attribution', 'turn', 'confidence']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The classifier’s labels, checked (rule 1): one per ref it was asked about, in that order, each its enums and a turn it
 * was given, or unlabeled. In a UAT run it may also propose failures nothing pointed at; those pass the same way.
 * @param {any} answer  the classifier’s parsed answer: { labels: [...], proposed?: [...] }
 * @param {{ asked: string[], turns: Set<string>, proposals?: boolean }} given
 * @returns {{ labels: any[], proposed: any[], unlabeled: number }}
 */
export function labelsOf(answer, { asked, turns, proposals = false }) {
  const byRef = new Map();
  for (const l of Array.isArray(answer?.labels) ? answer.labels : []) if (isObj(l) && typeof l.on === 'string' && !byRef.has(l.on)) byRef.set(l.on, l);
  const fine = (l) =>
    isObj(l) &&
    Object.keys(l).every((k) => LABEL_KEYS.has(k)) &&
    MAST.includes(l.mast) &&
    AREAS.includes(l.area) &&
    ATTRIBUTIONS.includes(l.attribution) &&
    CONFIDENCE.includes(l.confidence) &&
    (l.turn === undefined || l.turn === null || (typeof l.turn === 'string' && turns.has(l.turn)));
  const pick = (l) => ({ mast: l.mast, area: l.area, attribution: l.attribution, confidence: l.confidence, ...(l.turn ? { turn: l.turn } : {}) });
  const labels = asked.map((on, i) => {
    const l = byRef.get(on);
    return i < MAX_LABELS && l && fine(l) ? { on, ...pick(l) } : { on, label: UNLABELED };
  });
  const proposed = proposals
    ? (Array.isArray(answer?.proposed) ? answer.proposed : [])
        .slice(0, 20)
        .filter((l) => fine({ ...l, on: undefined }))
        .map(pick)
    : [];
  return { labels, proposed, unlabeled: labels.filter((l) => l.label === UNLABELED).length };
}

// ── Rule 3: the final check ──────────────────────────────────────────────────────────────

const en = (list) => (v) => list.includes(v);
const re = (pattern) => (v) => typeof v === 'string' && pattern.test(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e13;
const bool = (v) => typeof v === 'boolean';
const T = re(/^t\d{1,5}$/);
const ITEM = re(/^i\d{1,5}$/);
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
  recording: obj({ started: num, ended: num, history: bool }),
  room: obj(
    Object.fromEntries([
      ['kind', en(['dm', 'room'])],
      ...[
        'agents',
        'personMessages',
        'turns',
        'sideThreads',
        'topicThreads',
        'wakeChains',
        'longestWakeChain',
        'hopConfirms',
        'compactions',
        'initiativeEntropy',
      ].map((k) => [k, num]),
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
      mcpServers: num,
    }),
  ),
  turns: list(
    obj({
      ref: T,
      agent: AGENT,
      woke: en(WOKE),
      recorded: bool,
      ended: en(ENDED),
      tools: map(en(TOOL_CLASSES), num),
      ...Object.fromEntries(
        ['wallMs', 'firstOutputMs', 'tokensIn', 'tokensOut', 'costUsd', 'toolErrors', 'refusals', 'loops', 'tokensAfterLoop', 'subagents', 'jobs'].map((k) => [
          k,
          num,
        ]),
      ),
    }),
  ),
  prompts: list(obj({ turn: T, tool: en(TOOL_CLASSES), mode: en(MODES), outcome: en(OUTCOMES), waitMs: num })),
  blocks: list(obj({ ref: ITEM, type: en(BLOCK_TYPES), revisions: num, answered: bool, answerMs: num, versions: num, checkFailures: num })),
  work: obj({ files: en(BUCKETS), lines: en(BUCKETS), commands: num, commits: num, pushes: num }),
  gaps: list(obj({ kind: en(GAP_KINDS), turn: T, check: 'check', agent: AGENT, reason: en(GAP_REASONS) })),
  checks: obj({
    found: list(obj({ ref: re(/^c\d{1,4}$/), check: 'check', issue: num, count: num, refs: list((v) => T(v) || ITEM(v)) })),
    notRun: list(obj({ check: 'check', missing: list(en(INPUTS)) })),
  }),
  reactions: list(obj({ ref: re(/^r\d{1,5}$/), emoji: en(EMOJIS), on: ITEM, detectMs: num })),
  labels: list(
    obj({
      on: re(/^[cr]\d{1,5}$/),
      label: en(['unlabeled']),
      mast: en(MAST),
      area: en(AREAS),
      attribution: en(ATTRIBUTIONS),
      turn: T,
      confidence: en(CONFIDENCE),
    }),
  ),
  proposed: list(obj({ mast: en(MAST), area: en(AREAS), attribution: en(ATTRIBUTIONS), turn: T, confidence: en(CONFIDENCE) })),
});

/**
 * Every field of a report that isn’t Postbox’s vocabulary, a ref, an id or a number where the schema says, as paths:
 * empty when the report may be saved. Never the values.
 * @param {any} report
 * @param {{ checkIds: string[], build?: { version?: string|null, commit?: string|null } }} vocab  the check ids Postbox has
 *   (server/room-checks.mjs), and its own version and commit: a report names this build, and nothing else in those fields
 * @returns {string[]}
 */
export function finalCheck(report, { checkIds, build = {} }) {
  /** @type {string[]} */
  const out = [];
  const check = (spec, v, path) => {
    if (spec === 'check') return checkIds.includes(v) || out.push(path);
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
