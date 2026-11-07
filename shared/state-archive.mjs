// An old turn leaving the in-memory state (#305; designs/305-archive-turns.md, “What the reducer does”): its work entries
// give way to one turn summary entry, and its replies keep only how many activity steps they had. The rest is in the
// turn’s archive file, named by its SHA-256, which the server publishes before this event names it.

import { itemOf } from './item-index.mjs';

const isString = (v) => typeof v === 'string';
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isSha256 = (v) => isString(v) && /^[a-f0-9]{64}$/.test(v);
const isReply = (r) => r !== null && typeof r === 'object' && isString(r.threadId) && isString(r.id);

/**
 * Throws on a payload the reducer can’t read, before anything changes, so the store keeps the event as rejected (#609).
 * @param {any} d
 */
function checkPayload(d) {
  const fault = (what) => new Error(`A turn.archive event needs ${what}.`);
  if (!isString(d?.convId)) throw fault('a convId string');
  if (!isString(d.turnId)) throw fault('a turnId string');
  if (!isString(d.sha256)) throw fault('a sha256 string');
  const s = d.summary;
  if (s === null || typeof s !== 'object' || s.kind !== 'turn-archive' || !Array.isArray(s.entryIds)) {
    throw fault('a summary of kind turn-archive with an entryIds list');
  }
  if (!isString(s.id) || !isNumber(s.at) || !s.entryIds.every(isString)) throw fault('a summary with an id, an at time and string entryIds');
  if (!isSha256(d.sha256) || s.sha256 !== d.sha256) throw fault('a lowercase hex SHA-256 that the summary names too');
  // The summary is what a replay finds the turn by, so it names the same turn, or a second event wouldn’t be a repeat.
  if (s.turnId !== d.turnId) throw fault('a summary for the same turnId');
  if (!Array.isArray(d.items) || !d.items.every(isReply)) throw fault('an items list of { threadId, id }');
}

/** The fields a summary’s `counts` and `effort` may hold (designs/305-archive-turns.md, “Records”). */
const COUNTS = ['files', 'edits', 'commands', 'failed', 'reads', 'publishes', 'steps'];
const EFFORT = ['turns', 'ms', 'toolCalls', 'costUsd', 'tokens'];

/** The numbers of `from` named in `keys`, and nothing else. @param {any} from @param {string[]} keys */
function numbersOf(from, keys) {
  const out = {};
  for (const k of keys) if (isNumber(from?.[k])) out[k] = from[k];
  return out;
}

/**
 * The summary entry the work list keeps, built from the design’s fields only (“Records”), so the event is public
 * without carrying anything a pass, or a bug in one, adds to it: a command, an output or a path never reaches the page.
 * @param {any} s  the event’s summary, already checked
 */
function summaryEntry(s) {
  const counts = numbersOf(s.counts, COUNTS);
  if (isNumber(s.counts?.lines?.added) && isNumber(s.counts?.lines?.removed)) {
    counts.lines = { added: s.counts.lines.added, removed: s.counts.lines.removed };
  }
  const handles = Array.isArray(s.handles) ? s.handles.filter(isString) : [];
  const { id, kind, turnId, at, sha256 } = s;
  return { id, kind, turnId, at, sha256, entryIds: [...s.entryIds], counts, effort: numbersOf(s.effort, EFFORT), handles };
}

/**
 * The work list with the summary in place of the entries it lists: at the first one’s index, or, when none of them is
 * there (a reply-only turn), before the first entry that is later than it. A new array, never the old one changed: the
 * work index (shared/work-index.mjs) is kept per array and assumes a conversation’s entries only grow.
 * @param {any[]} list @param {any} summary
 */
function withSummary(list, summary) {
  const moved = new Set(summary.entryIds);
  const first = list.findIndex((e) => moved.has(e.id));
  const kept = list.filter((e) => !moved.has(e.id));
  const later = kept.findIndex((e) => e.at > summary.at);
  let at = kept.length;
  if (first >= 0) at = first;
  else if (later >= 0) at = later;
  return [...kept.slice(0, at), summary, ...kept.slice(at)];
}

/**
 * Applies a turn.archive event, idempotently: a turn whose summary is already in the list changes no work, and a reply
 * already archived keeps the archive it names. What isn’t there (the conversation, an entry, a thread or a reply) is
 * skipped. Only the listed entries leave: the turn’s `branch`, `commit`, `push` and `external` create entries stay hot
 * because the pass doesn’t list them (designs/305-archive-turns.md, “Which entries stay hot”), not because this checks.
 * @param {any} s  the state
 * @param {{ convId: string, turnId: string, sha256: string, summary: any, items: { threadId: string, id: string }[] }} d
 */
export function applyTurnArchive(s, d) {
  checkPayload(d);
  const list = s.work?.[d.convId];
  if (list && !list.some((e) => e.kind === 'turn-archive' && e.turnId === d.turnId)) {
    s.work[d.convId] = withSummary(list, summaryEntry(d.summary));
  }
  // Each reply by its own thread: a topic or side thread keeps its replies under its id, while work is the
  // conversation’s. `count`, not `steps`: the page reads `activity.steps` as a list.
  for (const { threadId, id } of d.items) {
    const replies = s.items[threadId];
    const reply = replies && itemOf(replies, id);
    if (reply?.activity && !reply.activity.archived) {
      reply.activity = { archived: d.sha256, count: reply.activity.steps?.length ?? 0 };
    }
  }
}
