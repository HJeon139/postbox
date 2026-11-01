// The archive pass (#305; designs/305-archive-turns.md, “Write path”): a conversation keeps its last two turns’ work
// entries and reply activity in the state, and each older ended turn moves to an archive file in the blob store. The
// file is published before the turn.archive event that names it (I1), and the event is a one-event commit whose
// function checks, when it is sequenced, that the state still holds exactly what the file holds (I5, I8).

import { createHash } from 'node:crypto';

/** How many of a conversation’s newest turns stay hot. */
export const HOT_TURNS = 2;

const sha = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');

/** The conversation’s threads: itself and the topic and side threads off it (one level, as runtime.mjs:1798). */
function threadsOf(state, convId) {
  return [
    convId,
    ...Object.values(state.threads ?? {})
      .filter((t) => t.parentId === convId)
      .map((t) => t.id),
  ];
}

/**
 * The conversation’s hot turns, oldest first by each turn’s first entry or reply, with what archiving one would move.
 * @param {any} state @param {string} convId
 * @returns {{ turnId: string, at: number, work: any[], replies: { threadId: string, item: any }[] }[]}
 */
export function hotTurns(state, convId) {
  /** @type {Map<string, { turnId: string, at: number, order: number, work: any[], replies: { threadId: string, item: any }[] }>} */
  const turns = new Map();
  const turn = (/** @type {string} */ turnId, /** @type {number} */ at) => {
    if (!turns.has(turnId)) turns.set(turnId, { turnId, at, order: turns.size, work: [], replies: [] });
    const t = /** @type {any} */ (turns.get(turnId));
    if (at < t.at) t.at = at;
    return t;
  };
  const archived = new Set();
  for (const e of state.work?.[convId] ?? []) {
    if (e.kind === 'turn-archive') archived.add(e.turnId);
    else if (e.turnId) turn(e.turnId, e.at ?? e.startedAt ?? 0).work.push(e);
  }
  for (const threadId of threadsOf(state, convId))
    for (const item of state.items?.[threadId] ?? [])
      if (item.turnId && item.activity && !item.activity.archived) turn(item.turnId, item.at ?? Infinity).replies.push({ threadId, item });
  return [...turns.values()].filter((t) => !archived.has(t.turnId)).sort((a, b) => a.at - b.at || a.order - b.order);
}

/** The text of what archiving a turn removes from the state: the file’s body, and what I5 hashes again. */
function payload(/** @type {string} */ convId, /** @type {any} */ t) {
  /** @type {Record<string, Record<string, any>>} */
  const activity = {};
  for (const { threadId, item } of t.replies) (activity[threadId] ??= {})[item.id] = item.activity;
  return JSON.stringify({ v: 1, convId, turnId: t.turnId, work: t.work, activity });
}

/** The summary entry that stands in for an archived turn (the design, “Records”). */
function summaryOf(/** @type {any} */ t, /** @type {string} */ sha256) {
  const of = (/** @type {string} */ kind) => t.work.filter((/** @type {any} */ e) => e.kind === kind);
  const changes = of('change');
  const commands = of('command');
  return {
    id: `wa_${t.turnId}`,
    kind: 'turn-archive',
    turnId: t.turnId,
    at: t.at,
    sha256,
    counts: {
      files: new Set(changes.map((/** @type {any} */ c) => c.fileId)).size,
      lines: { added: changes.reduce((n, c) => n + (c.added ?? 0), 0), removed: changes.reduce((n, c) => n + (c.deleted ?? 0), 0) },
      commands: commands.length,
      failed: commands.filter((/** @type {any} */ c) => c.state === 'failed').length,
      reads: of('read').length,
      publishes: of('publish').length,
      steps: t.replies.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + (r.item.activity.steps?.length ?? 0), 0),
    },
    effort: effortOf(t.work.filter((/** @type {any} */ e) => e.kind === 'turn')),
    handles: [...new Set([...t.work, ...t.replies.map((/** @type {any} */ r) => r.item)].map((x) => x.handle).filter(Boolean))],
  };
}

/** What the turn entry says the turn cost, so the conversation’s totals (shared/work.mjs `summarize`) keep it. */
function effortOf(/** @type {any[]} */ turns) {
  /** @type {Record<string, number>} */
  const tokens = {};
  for (const t of turns) for (const [k, v] of Object.entries(t.tokens ?? {})) tokens[k] = (tokens[k] ?? 0) + (Number(v) || 0);
  const sum = (/** @type {string} */ k) => turns.reduce((n, t) => n + (t[k] ?? 0), 0);
  return { turns: turns.length, ms: sum('ms'), toolCalls: sum('toolCalls'), costUsd: sum('costUsd'), tokens };
}

/**
 * The states an entry can still leave (server/ledger.mjs): `running` until it ends, `background` until its task ends
 * (:434), and `unknown`, which Stop's keep choice turns back into `background` (:453). Any other state is final.
 */
const OPEN = new Set(['running', 'background', 'unknown']);

/** I4: a turn may go once it has ended, nothing in it can change any more, and none of its jobs is kept. */
const finished = (/** @type {any} */ t, /** @type {Set<string>} */ busy) =>
  !busy.has(t.turnId) && !t.work.some((/** @type {any} */ e) => OPEN.has(e.state) || (e.kind === 'turn' && e.status === 'running'));

/**
 * Archives a conversation’s older ended turns, oldest first, one commit each, until only the last two and any turn that
 * can’t go yet are hot. A turn that can’t go is passed over, so one old command left `unknown` blocks nothing after it.
 * `running` holds the turns still running or with a kept job (the runtime’s to say). Stops quietly when the state
 * changed under it (the next turn’s end tries again); a failed put or commit rejects.
 * @param {{ store: any, blobs: { put(buf: Buffer): Promise<{ sha256: string }> }, convId: string, running: Set<string> | (() => Set<string>), canWrite?: () => boolean }} o
 * @returns {Promise<number>} how many turns it archived
 */
export async function archiveTurns({ store, blobs, convId, running, canWrite = () => true }) {
  // Who is busy is read for each turn, not once per run: a run spans fsyncs.
  const busy = () => (typeof running === 'function' ? running() : running);
  let n = 0;
  for (;;) {
    // Before each file, not only at the start, so a store closing mid-run gets no file after it.
    if (!canWrite()) return n;
    const t = hotTurns(store.state, convId)
      .slice(0, -HOT_TURNS)
      .find((x) => finished(x, busy()));
    if (!t) return n;
    const { sha256 } = await blobs.put(Buffer.from(payload(convId, t)));
    const summary = summaryOf(t, sha256);
    const items = t.replies.map((r) => ({ threadId: r.threadId, id: r.item.id }));
    let changed = false;
    const done = await store.commit(
      (/** @type {any} */ state) => {
        const now = hotTurns(state, convId).find((x) => x.turnId === t.turnId);
        if (!now || !finished(now, busy()) || sha(payload(convId, now)) !== sha256) {
          changed = true;
          return [];
        }
        return [{ type: 'turn.archive', data: { convId, turnId: t.turnId, sha256, summary, items } }];
      },
      // The conversation in the opId too: a turn id is unique only by convention, so two conversations can share one.
      { opId: `turn.archive:${convId}:${t.turnId}` },
    );
    // A duplicate wrote nothing; if the turn is still hot, committing it again would loop. Stop, as for a change.
    if (changed || done?.duplicate) return n;
    n++;
  }
}
