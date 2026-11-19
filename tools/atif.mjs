// Postbox’s recorded events as ATIF v1.8 trajectories (Harbor’s Agent Trajectory Interchange Format,
// https://docs.harborframework.com/agents/atif; its models are harbor-framework/harbor, src/harbor/models/trajectories/).
// One trajectory per agent session, from the events alone: every timestamp is a time Postbox’s server set (an item’s
// `at`, a block answer’s `at`, a clock event’s `at`), never one an agent’s host reported.
//
// What becomes a step, in the order the events added it:
// - user: a message of the person’s that one of the agent’s turns took from its inbox (designs/rooms-at-scale.md), and
//   the person’s answer to one of the agent’s blocks;
// - agent: each reply of the agent’s, with its tool calls and thoughts (tools/atif-calls.mjs), and each block or app
//   it showed;
// - system: another agent’s reply that one of its turns took, and each of its run clock’s events (server/run-clock.mjs).
// A message in the room that never reached the agent’s inbox is no step of its, even where its catch-up showed it as
// background. Tokens and cost come from the work ledger (tools/atif-metrics.mjs).

import { callsOf } from './atif-calls.mjs';
import { finalMetrics, meter } from './atif-metrics.mjs';

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
/** The work ledger’s entries for one call, which keep its arguments (tools/atif-calls.mjs). */
const CALL_KINDS = new Set(['command', 'external', 'read']);

/**
 * The events folded into what the trajectories read: each item as it ended, in the order it was added, each step of a
 * reply with the most it ever carried, the sessions, each inbox’s entries, the ledger’s turns and calls, and the clock
 * events, in order. @param {Event[]} events @param {any[]} live  live frames, for the steps’ input and output
 */
export function foldEvents(events, live = []) {
  const f = { items: new Map(), order: [], sessions: new Map(), entries: new Map(), work: new Map(), clocks: [] };
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
  } else if (e.type === 'item.patch' || e.type === 'item.move') patchItem(f.items.get(d.id), d);
  else if (e.type === 'session') f.sessions.set(d.id, { ...f.sessions.get(d.id), ...d });
  else if (e.type === 'session.patch') f.sessions.set(d.id, { ...f.sessions.get(d.id), ...d.patch });
  else if (e.type === 'entry.add' || e.type === 'entry.put') inboxOf(f, d.sessionId).set(d.entry.id, { ...d.entry });
  else if (e.type === 'entry.patch') Object.assign(inboxOf(f, d.sessionId).get(d.id) ?? {}, d.patch);
  else if (e.type === 'work.add' && (d.entry?.kind === 'turn' || CALL_KINDS.has(d.entry?.kind))) f.work.set(d.entry.id, { ...d.entry });
  else if (e.type === 'work.patch' && f.work.has(d.id)) Object.assign(f.work.get(d.id), d.patch);
  else if (Object.hasOwn(CLOCK_WORDS, e.type)) f.clocks.push({ seq: e.seq, type: e.type, data: d });
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

/** An item patch or move: its fields, a step, or an answer; never a move’s new `at`, so a step keeps when it was added. */
function patchItem(it, d) {
  if (!it) return;
  if (d.activityStep) mergeStep(it, d.activityStep);
  const { at: _moved, activity: _activity, ...patch } = d.patch ?? {};
  Object.assign(it, patch);
}

/** An agent step for one of the session’s replies. @param {any} it @param {any} ctx */
function replyStep(it, ctx) {
  const { tool_calls, results, thoughts } = callsOf(it, ctx.calls);
  const metrics = ctx.meter.take(it.turnId);
  return {
    source: 'agent',
    message: it.text ?? '',
    ...(it.model ? { model_name: it.model } : {}),
    ...(thoughts.length ? { reasoning_content: thoughts.join('\n\n') } : {}),
    ...(tool_calls.length ? { tool_calls } : {}),
    ...(results.length ? { observation: { results } } : {}),
    ...(metrics ? { metrics } : {}),
    extra: { item_id: it.id, turn_id: it.turnId ?? null, status: it.status ?? null, ...(it.stopReason ? { stop_reason: it.stopReason } : {}) },
  };
}

/** A block or app the agent showed, and the person’s answer to it. @param {any} it @param {any} ctx */
function shownSteps(it, ctx) {
  const metrics = ctx.meter.take(it.turnId);
  const shown = {
    timestamp: iso(it.at),
    source: 'agent',
    message: it.block?.fallback ?? it.title ?? '',
    ...(metrics ? { metrics } : {}),
    extra: { item_id: it.id, turn_id: it.turnId ?? null, kind: it.kind, block_type: it.block?.type ?? null },
  };
  const a = it.answer;
  if (!a || typeof a.at !== 'number') return [shown];
  const answer = {
    timestamp: iso(a.at),
    source: 'user',
    message: `${a.action}: ${JSON.stringify(a.values ?? {})}`,
    extra: { item_id: it.id, answer_to: it.block?.id ?? null },
  };
  return [shown, answer];
}

/** The steps one item gives the session’s trajectory, each with when it happened. @param {any} it @param {any} ctx */
function itemSteps(it, ctx) {
  const mine = it.sessionId === ctx.sessionId;
  if (it.kind === 'agent' && mine) return [{ timestamp: iso(it.at), ...replyStep(it, ctx) }];
  if ((it.kind === 'block' || it.kind === 'app') && mine) return shownSteps(it, ctx);
  // Someone else’s words are a step only when they reached this agent’s inbox.
  const entry = ctx.delivered.get(it.id);
  if (!entry) return [];
  const got = { item_id: it.id, entry_id: entry.id, taken_by_turn: entry.takenBy ?? null };
  if (it.kind === 'user') return [{ timestamp: iso(it.at), source: 'user', message: it.text ?? '', extra: got }];
  if (it.kind === 'agent') return [{ timestamp: iso(it.at), source: 'system', message: `@${it.handle}: ${it.text ?? ''}`, extra: { ...got, from: it.handle } }];
  return [];
}

/** The context one session’s steps are built in. @param {ReturnType<typeof foldEvents>} f @param {string} sessionId */
function contextOf(f, sessionId) {
  const turns = new Map([...f.work.values()].filter((w) => w.kind === 'turn' && w.sessionId === sessionId).map((w) => [w.id, w]));
  const calls = new Map([...f.work.values()].filter((w) => CALL_KINDS.has(w.kind) && w.toolUseId).map((w) => [w.toolUseId, w]));
  // Taken by one of its turns: an entry still waiting (sent after its clock expired, say) never reached the agent.
  const delivered = new Map([...(f.entries.get(sessionId)?.values() ?? [])].filter((e) => e.itemId && e.takenBy).map((e) => [e.itemId, e]));
  return { sessionId, turns, calls, delivered, meter: meter(turns) };
}

/**
 * One agent session’s trajectory, or null when the events give it no step.
 * @param {ReturnType<typeof foldEvents>} f @param {string} sessionId @param {{ version: string }} opts
 */
export function trajectoryOf(f, sessionId, { version }) {
  const se = f.sessions.get(sessionId) ?? {};
  const ctx = contextOf(f, sessionId);
  /** @type {{ seq: number, steps: any[] }[]} */
  const placed = f.order.map(({ seq, id }) => ({ seq, steps: itemSteps(f.items.get(id), ctx) }));
  for (const c of f.clocks.filter((x) => x.data.sessionId === sessionId))
    placed.push({
      seq: c.seq,
      steps: [{ timestamp: iso(c.data.at), source: 'system', message: CLOCK_WORDS[c.type](c.data), extra: { event: c.type, ...c.data } }],
    });
  const steps = placed
    .sort((a, b) => a.seq - b.seq)
    .flatMap((p) => p.steps)
    .map((s, i) => ({ step_id: i + 1, ...s }));
  if (!steps.length) return null;
  const handle = se.handle ?? [...f.items.values()].find((it) => it.sessionId === sessionId)?.handle ?? null;
  return {
    schema_version: 'ATIF-v1.8',
    session_id: sessionId,
    trajectory_id: sessionId,
    agent: {
      name: `postbox/${se.backend ?? 'unknown'}`,
      version,
      ...(se.lastModel ? { model_name: se.lastModel } : {}),
      extra: { handle, postbox_session: sessionId },
    },
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
  const ids = new Set([...f.items.values()].filter((it) => it.kind === 'agent' && it.sessionId).map((it) => it.sessionId));
  for (const c of f.clocks) ids.add(c.data.sessionId);
  return [...ids]
    .filter((id) => !sessionId || id === sessionId)
    .map((id) => ({ sessionId: id, trajectory: trajectoryOf(f, id, { version }) }))
    .filter((x) => x.trajectory)
    .map((x) => ({ ...x, handle: x.trajectory.agent.extra.handle }));
}
