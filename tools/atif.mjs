// Postbox’s recorded events as ATIF v1.8 trajectories (Harbor’s Agent Trajectory Interchange Format,
// https://docs.harborframework.com/agents/atif; its models are harbor-framework/harbor, src/harbor/models/trajectories/).
// One trajectory per agent session, from the events alone: every timestamp is a time Postbox’s server set (an item’s
// `at`, a block answer’s `at`, a clock event’s `at`), never one an agent’s host reported.
//
// What becomes a step, in the order the events added it:
// - user: a message of the person’s that one of the agent’s turns took from its inbox (designs/rooms-at-scale.md), and
//   the person’s answer to one of the agent’s blocks, once it reached the agent;
// - agent: each reply of the agent’s, with its tool calls and thoughts (tools/atif-calls.mjs), and each block or app
//   it showed;
// - system: another agent’s reply that one of its turns took, and each of its run clock’s events (server/run-clock.mjs).
// A message in the room that never reached the agent’s inbox is no step of its, even where its catch-up showed it as
// background. Tokens and cost come from the work ledger (tools/atif-metrics.mjs).

import { callsOf } from './atif-calls.mjs';
import { finalMetrics, meter } from './atif-metrics.mjs';
import { promptSteps, scopeOf, unresolvedGuides } from './atif-prompts.mjs';

export { NOT_RECORDED, NOT_RECORDED_WITHOUT_PROMPTS } from './atif-prompts.mjs';

/** @typedef {{ seq: number, type: string, data: any }} Event */

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
const CLOCK_WORDS = {
  'clock.started': (d) => `Run clock started with a budget of ${d.budgetMs / 1000}s.`,
  'clock.paused': () => 'Run clock paused: Postbox stopped the agent until it resumes.',
  'clock.resumed': () => 'Run clock resumed.',
  'clock.turn': (d) => `Turn started at elapsed ${Math.floor(d.elapsedMs / 1000)}s of ${d.budgetMs / 1000}s.`,
  'clock.restored': (d) =>
    `Postbox started again with the run clock at elapsed ${Math.floor(d.elapsedMs / 1000)}s of ${d.budgetMs / 1000}s; the time it was down counted.`,
  'clock.expired': (d) => `Run clock expired at its budget of ${d.budgetMs / 1000}s: Postbox stopped the agent.`,
};
/** The items an agent session shows: each is one of its steps. */
const OWN_KINDS = new Set(['agent', 'block', 'app']);
/** The work ledger’s entries for one call, which keep its arguments (tools/atif-calls.mjs). */
const CALL_KINDS = new Set(['command', 'external', 'read']);

/**
 * The events folded into what the trajectories read: each item as it ended, in the order it was added, each step of a
 * reply with the most it ever carried, the sessions, each inbox’s entries, the ledger’s turns and calls, and the clock
 * events, in order. @param {Event[]} events @param {any[]} live  live frames, for the steps’ input and output
 */
export function foldEvents(events, live = []) {
  const f = {
    items: new Map(),
    order: [],
    sessions: new Map(),
    models: new Map(),
    entries: new Map(),
    work: new Map(),
    clocks: [],
    guides: new Map(),
    prompts: [],
    takes: new Map(),
  };
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) foldOne(f, e);
  // A live step frame carries what changed of one step; a snapshot frame, a running turn’s steps as a page joins it.
  for (const l of live) {
    if (l?.kind === 'step') mergeStep(f.items.get(l.itemId), l.step ?? {});
    if (l?.kind === 'snapshot') for (const s of l.steps ?? []) mergeStep(f.items.get(l.itemId), s);
  }
  return f;
}

/** One event into the fold. @param {any} f @param {Event} e */
function foldOne(f, e) {
  const d = e.data;
  if (e.type === 'item.add') {
    const it = { ...d.item, threadId: d.threadId, steps: new Map() };
    f.items.set(it.id, it);
    f.order.push({ seq: e.seq, id: it.id });
    for (const s of d.item.activity?.steps ?? []) mergeStep(it, s);
  } else if (e.type === 'item.text') {
    const it = f.items.get(d.id);
    if (it) it.text = (it.text ?? '') + d.text;
  } else if (e.type === 'item.patch' || e.type === 'item.move') patchItem(f.items.get(d.id), d, e.seq);
  else if (e.type === 'session' || e.type === 'session.patch') {
    f.sessions.set(d.id, { ...f.sessions.get(d.id), ...(e.type === 'session' ? d : d.patch) });
    noteModel(f, d.id, e.seq);
  } else if (e.type === 'entry.add' || e.type === 'entry.put')
    noteTake(
      f,
      d.sessionId,
      inboxOf(f, d.sessionId)
        .set(d.entry.id, { ...d.entry })
        .get(d.entry.id),
      e.seq,
    );
  else if (e.type === 'entry.patch') noteTake(f, d.sessionId, Object.assign(inboxOf(f, d.sessionId).get(d.id) ?? {}, d.patch), e.seq);
  else if (e.type === 'work.add' && (d.entry?.kind === 'turn' || CALL_KINDS.has(d.entry?.kind))) f.work.set(d.entry.id, { ...d.entry, from: e.seq });
  else if (e.type === 'work.patch' && f.work.has(d.id)) Object.assign(f.work.get(d.id), d.patch, d.patch?.endedAt ? { to: e.seq } : {});
  else if (Object.hasOwn(CLOCK_WORDS, e.type)) f.clocks.push({ seq: e.seq, type: e.type, data: d });
  else if (e.type === 'turn.guide') f.guides.set(d.sha, d.text);
  else if (e.type === 'turn.prompt') f.prompts.push({ seq: e.seq, data: d });
}

/**
 * Each model and effort a session’s backend reported, with where in the events it did (`lastModel`, `lastEffort`,
 * server/turn-context.mjs), so each step is credited to the model that ran it, not to the session’s last.
 * @param {any} f @param {string} id @param {number} seq
 */
function noteModel(f, id, seq) {
  const se = f.sessions.get(id);
  if (typeof se?.lastModel !== 'string') return;
  const list = f.models.get(id) ?? [];
  const last = list.at(-1);
  if (!last || last.model !== se.lastModel || last.effort !== se.lastEffort) list.push({ seq, model: se.lastModel, effort: se.lastEffort ?? null });
  f.models.set(id, list);
}

/**
 * The model and effort that ran a step at `seq` in turn `turn`: the last its backend reported within that turn (from
 * its ledger entry to its end, which a report after the turn’s first words still falls in: Codex reports the model
 * that ran when the turn completes), else the last before the step, else the first after it.
 * @param {{ seq: number, model: string, effort: string|null }[]} list @param {number} seq @param {{ from?: number, to?: number } | undefined} turn
 */
function ranAt(list, seq, turn) {
  const inTurn = turn?.from === undefined ? [] : list.filter((m) => m.seq > turn.from && m.seq <= (turn.to ?? Number.POSITIVE_INFINITY));
  return inTurn.at(-1) ?? list.findLast((m) => m.seq <= seq) ?? list[0] ?? null;
}

/** What ran a step of turn `turnId`, as its fields. @param {any} ctx @param {number} seq @param {string | null | undefined} turnId */
function modelFields(ctx, seq, turnId) {
  const ran = ranAt(ctx.models, seq, turnId ? ctx.turns.get(turnId) : undefined);
  return ran ? { model_name: ran.model, ...(ran.effort ? { reasoning_effort: ran.effort } : {}) } : {};
}

/**
 * The first time one of a session’s turns took an entry with an item, with the item’s text then: what reached the
 * agent, as it read it, whatever later edits the item, or a retry that gives the entry back to the inbox, do to the
 * final state (hydrant-critic’s review of #1522). @param {any} f @param {string} sessionId @param {any} e @param {number} seq
 */
function noteTake(f, sessionId, e, seq) {
  if (!e?.takenBy || !e.itemId) return;
  const key = `${sessionId}\u0000${e.itemId}`;
  if (!f.takes.has(key))
    f.takes.set(key, { sessionId, itemId: e.itemId, entryId: e.id, source: e.source, turnId: e.takenBy, seq, text: f.items.get(e.itemId)?.text });
}

/** A session’s entries, by id. @param {any} f @param {string} sessionId @returns {Map<string, any>} */
function inboxOf(f, sessionId) {
  if (!f.entries.has(sessionId)) f.entries.set(sessionId, new Map());
  return f.entries.get(sessionId);
}

/** A step’s fields over what it had, keeping its input and output once the fold has dropped them. @param {any} it @param {any} s */
function mergeStep(it, s) {
  if (!it || typeof s?.id !== 'string') return;
  it.steps.set(s.id, { ...it.steps.get(s.id), ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) });
}

/**
 * An item patch or move: its fields, a step, or an answer; never a move’s new `at`, so a step keeps when it was added.
 * An answer keeps the place in the events of the patch that brought it, where its step goes (trajectoryOf).
 * @param {any} it @param {any} d @param {number} seq
 */
function patchItem(it, d, seq) {
  if (!it) return;
  if (d.activityStep) mergeStep(it, d.activityStep);
  const { at: _moved, activity: _activity, ...patch } = d.patch ?? {};
  if (patch.answer?.at !== undefined && patch.answer.at !== it.answer?.at) it.answerSeq = seq;
  Object.assign(it, patch);
}

/** An agent step for one of the session’s replies. @param {any} it @param {any} ctx @param {number} seq  where it was added */
function replyStep(it, ctx, seq) {
  const { tool_calls, results, thoughts } = callsOf(it, ctx.calls);
  const metrics = ctx.meter.take(it.turnId);
  return {
    source: 'agent',
    message: it.text ?? '',
    ...modelFields(ctx, seq, it.turnId),
    ...(thoughts.length ? { reasoning_content: thoughts.join('\n\n') } : {}),
    ...(tool_calls.length ? { tool_calls } : {}),
    ...(results.length ? { observation: { results } } : {}),
    ...(metrics ? { metrics } : {}),
    extra: { item_id: it.id, turn_id: it.turnId ?? null, status: it.status ?? null, ...(it.stopReason ? { stop_reason: it.stopReason } : {}) },
  };
}

/** A block or app the agent showed, and the person’s answer to it. @param {any} it @param {any} ctx @param {number} seq */
function shownSteps(it, ctx, seq) {
  const metrics = ctx.meter.take(it.turnId);
  const shown = {
    timestamp: iso(it.at),
    source: 'agent',
    message: it.block?.fallback ?? it.title ?? '',
    ...modelFields(ctx, seq, it.turnId),
    ...(metrics ? { metrics } : {}),
    extra: { item_id: it.id, turn_id: it.turnId ?? null, kind: it.kind, block_type: it.block?.type ?? null },
  };
  const a = it.answer;
  if (!a || typeof a.at !== 'number') return [shown];
  // An answer reached the agent when its call took it at once (an AskUserQuestion, `read`), or when one of its turns
  // took the answer’s entry from its inbox (server/blocks.mjs): one that only waits there, as after its clock expired, didn’t.
  const entry = ctx.delivered.get(it.id);
  if (a.read !== true && entry?.source !== 'answer') return [shown];
  const answer = {
    timestamp: iso(a.at),
    source: 'user',
    message: `${a.action}: ${JSON.stringify(a.values ?? {})}`,
    extra: { item_id: it.id, answer_to: it.block?.id ?? null, ...(entry ? { entry_id: entry.entryId, taken_by_turn: entry.turnId } : {}) },
    // Placed where its patch came, not beside the block: other steps can come between them.
    seq: it.answerSeq,
  };
  return [shown, answer];
}

/**
 * The steps one item gives the session’s trajectory, each with when it happened.
 * @param {any} it @param {any} ctx @param {number} seq  where in the events it was added
 */
function itemSteps(it, ctx, seq) {
  const mine = it.sessionId === ctx.sessionId;
  if (it.kind === 'agent' && mine) return [{ timestamp: iso(it.at), ...replyStep(it, ctx, seq) }];
  if ((it.kind === 'block' || it.kind === 'app') && mine) return shownSteps(it, ctx, seq);
  // Someone else’s words are a step only when they reached this agent’s inbox.
  const entry = ctx.delivered.get(it.id);
  if (!entry) return [];
  const got = { item_id: it.id, entry_id: entry.entryId, taken_by_turn: entry.turnId ?? null };
  const text = entry.text ?? it.text ?? '';
  if (it.kind === 'user') return [{ timestamp: iso(it.at), source: 'user', message: text, extra: got }];
  if (it.kind === 'agent') return [{ timestamp: iso(it.at), source: 'system', message: `@${it.handle}: ${text}`, extra: { ...got, from: it.handle } }];
  return [];
}

/** The context one session’s steps are built in. @param {ReturnType<typeof foldEvents>} f @param {string} sessionId */
function contextOf(f, sessionId) {
  const turns = new Map([...f.work.values()].filter((w) => w.kind === 'turn' && w.sessionId === sessionId).map((w) => [w.id, w]));
  const calls = new Map([...f.work.values()].filter((w) => CALL_KINDS.has(w.kind) && w.toolUseId).map((w) => [w.toolUseId, w]));
  // Taken by one of its turns, as it was when taken: an entry still waiting (sent after its clock expired, say) never
  // reached the agent, and one taken and given back by a retry did (noteTake).
  const delivered = new Map([...f.takes.values()].filter((t) => t.sessionId === sessionId).map((t) => [t.itemId, t]));
  return { sessionId, turns, calls, delivered, models: f.models.get(sessionId) ?? [], meter: meter(turns) };
}

/**
 * One agent session’s trajectory, or null when the events give it no step.
 * @param {ReturnType<typeof foldEvents>} f @param {string} sessionId @param {{ version: string }} opts
 */
export function trajectoryOf(f, sessionId, { version }) {
  const se = f.sessions.get(sessionId) ?? {};
  const ctx = contextOf(f, sessionId);
  /** @type {{ seq: number, steps: any[] }[]} */
  // A step that brings its own place (an answer, at its patch) goes there; the rest go where their item was added.
  const placed = f.order.flatMap(({ seq, id }) =>
    itemSteps(f.items.get(id), ctx, seq).map(({ seq: own, ...step }) => ({ seq: typeof own === 'number' ? own : seq, steps: [step] })),
  );
  for (const c of f.clocks.filter((x) => x.data.sessionId === sessionId))
    placed.push({
      seq: c.seq,
      steps: [{ timestamp: iso(c.data.at), source: 'system', message: CLOCK_WORDS[c.type](c.data), extra: { event: c.type, ...c.data } }],
    });
  const prompts = promptSteps(f, sessionId);
  placed.push(...prompts);
  const steps = placed
    .sort((a, b) => a.seq - b.seq)
    .flatMap((p) => p.steps)
    .map((s, i) => ({ step_id: i + 1, ...s }));
  if (!steps.length) return null;
  const handle = se.handle ?? [...f.items.values()].find((it) => it.sessionId === sessionId)?.handle ?? null;
  // A default model only when every step ran on it: else each step names its own, and extra lists them.
  const models = [...new Set(steps.map((s) => s.model_name).filter(Boolean))];
  return {
    schema_version: 'ATIF-v1.8',
    session_id: sessionId,
    trajectory_id: sessionId,
    agent: {
      name: `postbox/${se.backend ?? 'unknown'}`,
      version,
      ...(models.length === 1 ? { model_name: models[0] } : {}),
      extra: { handle, postbox_session: sessionId, ...(models.length > 1 ? { models } : {}) },
    },
    ...scopeOf(prompts.length > 0, unresolvedGuides(f, sessionId)),
    steps,
    final_metrics: finalMetrics(ctx.turns, ctx.meter.metered, steps.length),
  };
}

/**
 * Every agent session’s trajectory in the events, or only `sessionId`’s.
 * @param {Event[]} events @param {{ version: string, live?: any[], sessionId?: string }} opts
 * @returns {{ sessionId: string, handle: string|null, trajectory: any }[]}
 */
export function trajectories(events, { version, live = [], sessionId }) {
  const f = foldEvents(events, live);
  // Every session that showed something: a reply, a block or an app, so one whose only output was a block has one too.
  const ids = new Set([...f.items.values()].filter((it) => OWN_KINDS.has(it.kind) && it.sessionId).map((it) => it.sessionId));
  for (const c of f.clocks) ids.add(c.data.sessionId);
  return [...ids]
    .filter((id) => !sessionId || id === sessionId)
    .map((id) => ({ sessionId: id, trajectory: trajectoryOf(f, id, { version }) }))
    .filter((x) => x.trajectory)
    .map((x) => ({ ...x, handle: x.trajectory.agent.extra.handle }));
}
