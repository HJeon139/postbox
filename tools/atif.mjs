// Postbox’s recorded events as ATIF v1.8 trajectories (Harbor’s Agent Trajectory Interchange Format,
// https://docs.harborframework.com/agents/atif; its models are harbor-framework/harbor, src/harbor/models/trajectories/).
// One trajectory per agent session, from the events alone: every timestamp is a time Postbox’s server set (an item’s
// `at`, a block answer’s `at`, a clock event’s `at`), never one an agent’s host reported.
//
// What becomes a step, in the order the events added it:
// - user: the person’s message in the agent’s threads, and the person’s answer to one of the agent’s blocks;
// - agent: each reply of the agent’s, with its tool calls and thoughts, and each block or app it showed;
// - system: another agent’s reply in its threads, and each of its run clock’s events (server/run-clock.mjs).
// Tokens and cost come from the work ledger’s turn entries (work.add, work.patch), on the turn’s first reply, and only
// where the backend reported them: a missing figure is left out, never made up. Postbox keeps a call’s display label,
// not its tool name or raw arguments, so a tool call’s function_name is that label; its input and output are the
// live view’s cut text, which only live frames carry (a UAT run’s live.jsonl).

/** @typedef {{ seq: number, type: string, data: any }} Event */

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
const CLOCK_WORDS = {
  'clock.started': (d) => `Run clock started with a budget of ${d.budgetMs / 1000}s.`,
  'clock.paused': () => 'Run clock paused.',
  'clock.resumed': () => 'Run clock resumed.',
  'clock.turn': (d) => `Turn started at elapsed ${Math.floor(d.elapsedMs / 1000)}s of ${d.budgetMs / 1000}s.`,
  'clock.expired': (d) => `Run clock expired at its budget of ${d.budgetMs / 1000}s: Postbox stopped the agent.`,
};

/**
 * The events folded into what the trajectories read: each item as it ended, in the order it was added, each step of a
 * reply with the most it ever carried, the sessions, the turns’ usage, and the clock events, in order.
 * @param {Event[]} events @param {any[]} live  live frames, for the steps’ input and output
 */
export function foldEvents(events, live = []) {
  const items = new Map();
  const order = [];
  const sessions = new Map();
  const turns = new Map();
  const clocks = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const d = e.data;
    if (e.type === 'item.add') {
      const it = { ...d.item, threadId: d.threadId, steps: new Map() };
      items.set(it.id, it);
      order.push({ seq: e.seq, id: it.id });
      for (const s of d.item.activity?.steps ?? []) mergeStep(it, s);
    } else if (e.type === 'item.text') {
      const it = items.get(d.id);
      if (it) it.text = (it.text ?? '') + d.text;
    } else if (e.type === 'item.patch' || e.type === 'item.move') patchItem(items.get(d.id), d);
    else if (e.type === 'session') sessions.set(d.id, { ...sessions.get(d.id), ...d });
    else if (e.type === 'session.patch') sessions.set(d.id, { ...sessions.get(d.id), ...d.patch });
    else if (e.type === 'work.add' && d.entry?.kind === 'turn') turns.set(d.entry.id, { ...d.entry });
    else if (e.type === 'work.patch' && turns.has(d.id)) Object.assign(turns.get(d.id), d.patch);
    else if (Object.hasOwn(CLOCK_WORDS, e.type)) clocks.push({ seq: e.seq, type: e.type, data: d });
  }
  // A live step frame carries what changed of one step; a snapshot frame, a running turn’s steps as a page joins it.
  for (const f of live) {
    if (f?.kind === 'step') mergeStep(items.get(f.itemId), f.step ?? {});
    if (f?.kind === 'snapshot') for (const s of f.steps ?? []) mergeStep(items.get(f.itemId), s);
  }
  return { items, order, sessions, turns, clocks };
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

/** The tool calls and thoughts of a reply’s steps. @param {any} it */
function callsOf(it) {
  const steps = [...it.steps.values()].filter((s) => s.label && s.kind !== 'reply');
  const thoughts = steps.filter((s) => s.kind === 'thought').map((s) => s.detail ?? s.label);
  const calls = steps.filter((s) => s.kind !== 'thought');
  const tool_calls = calls.map((s) => ({
    tool_call_id: s.id,
    function_name: s.label,
    arguments: typeof s.input === 'string' ? { input: s.input } : {},
    extra: { state: s.state ?? null, ...(typeof s.ms === 'number' ? { ms: s.ms } : {}), ...(s.kind ? { kind: s.kind } : {}) },
  }));
  const results = calls
    .filter((s) => typeof s.output === 'string' || typeof s.detail === 'string')
    .map((s) => ({ source_call_id: s.id, content: s.output ?? s.detail }));
  return { tool_calls, results, thoughts };
}

/** A turn’s tokens and cost as ATIF metrics, or null when its backend reported neither. @param {any} turn */
export function metricsOf(turn) {
  const t = turn?.tokens;
  const cost = typeof turn?.costUsd === 'number' ? turn.costUsd : null;
  if (!t && cost === null) return null;
  return {
    ...(t
      ? { prompt_tokens: (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0), completion_tokens: t.output ?? 0, cached_tokens: t.cacheRead ?? 0 }
      : {}),
    ...(cost === null ? {} : { cost_usd: cost }),
    ...(t ? { extra: { cache_write_tokens: t.cacheWrite ?? 0 } } : {}),
  };
}

/** An agent step for one of the session’s replies. @param {any} it @param {Map<string, any>} turns @param {Set<string>} metered */
function replyStep(it, turns, metered) {
  const { tool_calls, results, thoughts } = callsOf(it);
  const turn = turns.get(it.turnId);
  // A turn’s figures go on its first reply only, so the steps’ sum is the turn’s.
  const metrics = turn && !metered.has(it.turnId) ? metricsOf(turn) : null;
  if (turn) metered.add(it.turnId);
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

/** The steps one item gives the session’s trajectory, each with when it happened. @param {any} it @param {string} sessionId @param {any} f */
function itemSteps(it, sessionId, f, metered) {
  const at = { timestamp: iso(it.at) };
  if (it.kind === 'user') return [{ ...at, source: 'user', message: it.text ?? '', extra: { item_id: it.id } }];
  if (it.kind === 'agent' && it.sessionId === sessionId) return [{ ...at, ...replyStep(it, f.turns, metered) }];
  if (it.kind === 'agent') return [{ ...at, source: 'system', message: `@${it.handle}: ${it.text ?? ''}`, extra: { item_id: it.id, from: it.handle } }];
  if ((it.kind === 'block' || it.kind === 'app') && it.sessionId === sessionId) {
    const shown = {
      ...at,
      source: 'agent',
      message: it.block?.fallback ?? it.title ?? '',
      extra: { item_id: it.id, kind: it.kind, block_type: it.block?.type ?? null },
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
  return [];
}

/**
 * One agent session’s trajectory, or null when the events give it no step.
 * @param {ReturnType<typeof foldEvents>} f @param {string} sessionId @param {{ version: string }} opts
 */
export function trajectoryOf(f, sessionId, { version }) {
  const se = f.sessions.get(sessionId) ?? {};
  const mine = [...f.items.values()].filter((it) => it.sessionId === sessionId);
  const threads = new Set([se.threadId, ...mine.map((it) => it.threadId)].filter(Boolean));
  const metered = new Set();
  /** @type {{ seq: number, steps: any[] }[]} */
  const placed = f.order
    .map(({ seq, id }) => ({ seq, it: f.items.get(id) }))
    .filter(({ it }) => threads.has(it.threadId))
    .map(({ seq, it }) => ({ seq, steps: itemSteps(it, sessionId, f, metered) }));
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
  return {
    schema_version: 'ATIF-v1.8',
    session_id: sessionId,
    trajectory_id: sessionId,
    agent: {
      name: `postbox/${se.backend ?? 'unknown'}`,
      version,
      ...(se.lastModel ? { model_name: se.lastModel } : {}),
      extra: { handle: se.handle ?? mine[0]?.handle ?? null, postbox_session: sessionId },
    },
    steps,
    final_metrics: finalMetrics(steps),
  };
}

/**
 * The sums of the steps’ metrics. A total is given only when every turn that has a step reported it; when only some
 * did, the sum of those is in extra, with how many turns reported it and how many didn’t, so a partial sum never
 * reads as the whole. @param {any[]} steps
 */
function finalMetrics(steps) {
  const turns = new Set(steps.filter((s) => s.source === 'agent' && s.extra?.turn_id).map((s) => s.extra.turn_id));
  const m = steps.map((s) => s.metrics).filter(Boolean);
  const totals = {};
  const partial = {};
  for (const [total, k] of FINAL) {
    const have = m.filter((x) => typeof x[k] === 'number');
    if (!have.length) continue;
    const sum = have.reduce((n, x) => n + x[k], 0);
    if (have.length >= turns.size) totals[total] = sum;
    else partial[total] = { sum, turns_reported: have.length, turns_unreported: turns.size - have.length };
  }
  return { ...totals, total_steps: steps.length, ...(Object.keys(partial).length ? { extra: { partial } } : {}) };
}

/** Each final total and the step metric it sums. */
const FINAL = [
  ['total_prompt_tokens', 'prompt_tokens'],
  ['total_completion_tokens', 'completion_tokens'],
  ['total_cached_tokens', 'cached_tokens'],
  ['total_cost_usd', 'cost_usd'],
];

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
