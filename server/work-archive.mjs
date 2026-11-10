// The archive pass (#305; designs/305-archive-turns.md, “Write path”): each agent keeps its last two turns’ work entries
// and reply activity in the state, and each older ended turn moves to an archive file in the blob store. The file is
// published before the turn.archive event that names it (I1), and the event is a one-event commit whose function checks,
// when it is sequenced, that the state still holds exactly what the file holds (I5, I8).

import { createHash } from 'node:crypto';

/** How many of each agent’s newest turns stay hot (“Which turns stay hot”): per agent, so a long turn isn’t archived the moment it ends while others finish short ones. */
export const HOT_TURNS_PER_AGENT = 2;

/** How many turns the pass archives between yields, so emits held behind its commits drain (“Existing data”). */
export const ARCHIVE_CHUNK = 20;

/** Entries the version-control readers patch after their turn (server/ledger-commands.mjs, server/ledger-git.mjs). */
const KEPT_KINDS = new Set(['branch', 'commit', 'push']);
/** The creates the write judge’s madeBy (server/write-intent.mjs) reads for the whole conversation. */
const CREATES = /^gh (pr|issue) create$/;

/**
 * Whether an entry stays in the state when its turn is archived (“Which entries stay hot”). A reader that decides
 * something reads the whole conversation’s list of these, so moving one would change its answer. O(1).
 * @param {any} e  a work entry
 */
export const kept = (e) => KEPT_KINDS.has(e.kind) || (e.kind === 'external' && e.via === 'gh' && CREATES.test(e.what ?? ''));

/**
 * The states an entry can still leave (I4): `running` until it ends, `background` until its task ends, and `unknown`,
 * which Stop’s keep choice turns back into `background`. Every other state is final.
 */
const OPEN = new Set(['running', 'background', 'unknown']);

const sha = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');
const sumTokens = (/** @type {any} */ t) => (t ? (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) : 0);

/**
 * A hot turn, as the pass reads it from the state.
 * @typedef {{ turnId: string, at: number, order: number, agent: string, all: any[], work: any[], replies: { threadId: string, item: any }[] }} Turn
 */

/** The conversation’s threads: itself and the topic and side threads off it. O(threads). @param {any} state @param {string} convId */
function threadsOf(state, convId) {
  const off = Object.values(state.threads ?? {}).filter((t) => t.parentId === convId);
  return [convId, ...off.map((t) => t.id)];
}

/** Who ran a turn: the agent its `turn` entry names, else the first entry or reply that names one. @param {any} x */
const agentOf = (x) => x.handle ?? x.sessionId ?? '';

/**
 * The conversation’s hot turns, by turn id, in the order they appear: work first, then replies by thread. `only`
 * gathers one turn, for the commit’s check. O(the conversation’s entries and its threads’ items).
 * @param {any} state @param {string} convId @param {string} [only]
 * @returns {Map<string, Turn>}
 */
function gather(state, convId, only) {
  /** @type {Map<string, Turn>} */
  const turns = new Map();
  const archived = new Set();
  const turnOf = (/** @type {string} */ turnId, /** @type {number} */ at, /** @type {any} */ by) => {
    let t = turns.get(turnId);
    if (!t) turns.set(turnId, (t = { turnId, at, order: turns.size, agent: agentOf(by), all: [], work: [], replies: [] }));
    if (at < t.at) t.at = at;
    // The `turn` entry names the agent that ran it, whatever came first.
    if (by.kind === 'turn' || !t.agent) t.agent = agentOf(by) || t.agent;
    return t;
  };
  for (const e of state.work?.[convId] ?? []) {
    if (e.kind === 'turn-archive') archived.add(e.turnId);
    if (e.kind === 'turn-archive' || !e.turnId || (only && e.turnId !== only)) continue;
    const t = turnOf(e.turnId, e.at ?? e.startedAt ?? 0, e);
    t.all.push(e);
    if (!kept(e)) t.work.push(e);
  }
  for (const threadId of threadsOf(state, convId))
    for (const item of state.items?.[threadId] ?? []) {
      if (!item.turnId || !item.activity || item.activity.archived || (only && item.turnId !== only)) continue;
      turnOf(item.turnId, item.at ?? Infinity, item).replies.push({ threadId, item });
    }
  for (const id of archived) turns.delete(id);
  return turns;
}

/** The hot turns oldest first, by each turn’s first entry or reply. O(t log t) on top of gather. @param {any} state @param {string} convId */
export function hotTurns(state, convId) {
  return [...gather(state, convId).values()].sort((a, b) => a.at - b.at || a.order - b.order);
}

/**
 * The turns older than their agent’s last HOT_TURNS_PER_AGENT, oldest first: what the pass may archive, before I4.
 * O(turns). @param {Turn[]} turns  oldest first
 */
function olderThanHot(turns) {
  /** @type {Map<string, number>} */
  const left = new Map(); // per agent, how many of its newest turns are still to keep, walking newest first
  const old = [];
  for (const t of [...turns].reverse()) {
    const keep = left.get(t.agent) ?? HOT_TURNS_PER_AGENT;
    left.set(t.agent, keep - 1);
    if (keep <= 0) old.push(t);
  }
  return old.reverse();
}

/** I4: ended, not live in the runtime, nothing in it can still change, and none of its jobs kept. O(the turn’s entries). */
const finished = (/** @type {Turn} */ t, /** @type {Set<string>} */ busy) =>
  !busy.has(t.turnId) && !t.all.some((e) => OPEN.has(e.state) || (e.kind === 'turn' && e.status === 'running'));

/** A turn with only kept entries and no reply activity has nothing to move: no file, and it blocks nothing after it. */
const movable = (/** @type {Turn} */ t) => t.work.length > 0 || t.replies.length > 0;

/**
 * The archive file’s text: what archiving the turn removes from the state, and what I5 hashes again. The read side
 * (server/work-archive-read.mjs) parses exactly this shape. O(the turn’s entries and activity).
 * @param {string} convId @param {Turn} t
 */
function payload(convId, t) {
  /** @type {Record<string, Record<string, any>>} */
  const activity = {};
  for (const { threadId, item } of t.replies) (activity[threadId] ??= {})[item.id] = item.activity;
  return JSON.stringify({ v: 1, convId, turnId: t.turnId, work: t.work, activity });
}

/** The numbers a summary keeps of the moved entries (“Records”), so the Work view’s totals keep them. O(entries). @param {Turn} t */
function countsOf(t) {
  const of = (/** @type {string} */ kind) => t.work.filter((e) => e.kind === kind);
  const changes = of('change');
  const commands = of('command');
  const lines = { added: 0, removed: 0 };
  for (const c of changes) {
    lines.added += c.added ?? 0;
    lines.removed += c.deleted ?? 0;
  }
  const steps = t.replies.reduce((n, r) => n + (r.item.activity.steps?.length ?? 0), 0);
  const files = new Set(changes.map((c) => c.fileId)).size;
  const failed = commands.filter((c) => c.state === 'failed').length;
  return { files, lines, edits: of('edit').length, commands: commands.length, failed, reads: of('read').length, publishes: of('publish').length, steps };
}

/** What the turn’s `turn` entry says it cost, so the conversation’s totals don’t shrink. O(entries). @param {Turn} t */
function effortOf(t) {
  const ts = t.work.filter((e) => e.kind === 'turn');
  const add = (/** @type {(e: any) => number} */ f) => ts.reduce((n, e) => n + f(e), 0);
  return {
    turns: ts.length,
    ms: add((e) => e.ms ?? 0),
    toolCalls: add((e) => e.toolCalls ?? 0),
    costUsd: add((e) => e.costUsd ?? 0),
    tokens: add((e) => sumTokens(e.tokens)),
  };
}

/** The turn.archive event’s payload (shared/state-archive.mjs). O(the turn). @param {string} convId @param {Turn} t @param {string} sha256 */
function eventOf(convId, t, sha256) {
  const handles = [...new Set([...t.work, ...t.replies.map((r) => r.item)].map((x) => x.handle).filter(Boolean))];
  const summary = {
    id: `wa_${t.turnId}`,
    kind: 'turn-archive',
    turnId: t.turnId,
    at: t.at,
    sha256,
    entryIds: t.work.map((e) => e.id),
    counts: countsOf(t),
    effort: effortOf(t),
    handles,
  };
  const items = t.replies.map((r) => ({ threadId: r.threadId, id: r.item.id }));
  return { convId, turnId: t.turnId, sha256, summary, items };
}

/**
 * Commits one turn’s archive. Its function runs when the commit is sequenced, against the state the store hands it
 * (I8): the turn must still be hot and finished, and its payload must hash to the file’s (I5), or nothing is written.
 * O(the conversation) inside the writer, for gather. Resolves true if the event was written.
 * @param {any} store @param {string} convId @param {{ t: Turn, sha256: string }} put @param {() => Set<string>} busy
 */
async function commitTurn(store, convId, { t, sha256 }, busy) {
  let changed = false;
  const check = (/** @type {any} */ state) => {
    const now = gather(state, convId, t.turnId).get(t.turnId);
    if (!now || !finished(now, busy()) || sha(payload(convId, now)) !== sha256) {
      changed = true;
      return [];
    }
    return [{ type: 'turn.archive', data: eventOf(convId, now, sha256) }];
  };
  // The conversation in the opId too: a turn id is unique only by convention, so two conversations can share one.
  const done = await store.commit(check, { opId: `turn.archive:${convId}:${t.turnId}` });
  // A duplicate wrote nothing; committing the same turn again would loop, so it counts as a stop.
  return !changed && !done?.duplicate;
}

/**
 * Up to `chunk` turns the pass may archive now, each with its file published (I1). The state is read once per chunk;
 * the commit checks each turn again. `canWrite` is asked before each file, so a store closing mid-chunk gets no file
 * after it. O(the conversation) plus one put per turn.
 * @param {any} store @param {any} blobs @param {string} convId @param {() => Set<string>} busy
 * @param {() => boolean} canWrite @param {number} chunk
 */
async function putChunk(store, blobs, convId, busy, canWrite, chunk) {
  const ready = olderThanHot(hotTurns(store.state, convId)).filter((t) => movable(t) && finished(t, busy()));
  const out = [];
  for (const t of ready.slice(0, chunk)) {
    if (!canWrite()) break;
    const { sha256 } = await blobs.put(Buffer.from(payload(convId, t)));
    out.push({ t, sha256 });
  }
  return out;
}

/**
 * Archives a conversation’s turns older than each agent’s last two, oldest first, one commit each, until none that can
 * go is left. A turn that fails I4 or has only kept entries is passed over, so it blocks nothing after it. Files are put
 * a chunk at a time outside any commit; the commits go one at a time, so an emit is held behind at most one fsync, and
 * the pass yields between chunks. Stops quietly when the state changed under a commit, or it was a duplicate (the next
 * turn’s end tries again); a failed put or commit, a closed store’s included, rejects with no retry.
 * O(the conversation) per chunk and per commit, plus one file write and one fsync per archived turn.
 * @param {{ store: any, blobs: { put(buf: Buffer): Promise<{ sha256: string }> }, convId: string,
 *   running: Set<string> | (() => Set<string>), canWrite?: () => boolean, chunk?: number }} o
 *   running: the turns still running or with a kept job (the runtime’s to say), read again at each check
 * @returns {Promise<number>} how many turns it archived
 */
export async function archiveTurns({ store, blobs, convId, running, canWrite = () => true, chunk = ARCHIVE_CHUNK }) {
  const busy = () => (typeof running === 'function' ? running() : running);
  let n = 0;
  for (;;) {
    if (!canWrite()) return n;
    const puts = await putChunk(store, blobs, convId, busy, canWrite, chunk);
    if (!puts.length) return n;
    for (const p of puts) {
      if (!(await commitTurn(store, convId, p, busy))) return n;
      n++;
    }
    await new Promise((r) => setImmediate(r));
  }
}
