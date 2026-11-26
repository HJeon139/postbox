// Postbox’s recorded events as ATIF v1.8 trajectories (Harbor’s Agent Trajectory Interchange Format,
// https://docs.harborframework.com/agents/atif; its models are harbor-framework/harbor, src/harbor/models/trajectories/).
// One trajectory per agent session, from the events alone: every timestamp is a time Postbox’s server set (an item’s
// `at`, a block answer’s `at`, a clock event’s `at`), never one an agent’s host reported.
//
// What becomes a step, in the order the events added it:
// - user: each turn’s prompt as its backend got it, when the run recorded prompts.jsonl (#1528, tools/atif-prompts.mjs),
//   carrying what the turn took from its inbox; else a message of the person’s that one of the agent’s turns took
//   (designs/rooms-at-scale.md), and the person’s answer to one of the agent’s blocks, once it reached the agent;
// - agent: each reply of the agent’s, with its tool calls and thoughts (tools/atif-calls.mjs); each block or app it
//   showed, as a step with no model call (`llm_call_count: 0`); an AskUserQuestion’s blocks are its call’s, not steps;
// - system: the guide Postbox gave the backend, and another agent’s reply that one of its turns took, without prompts.
// A message in the room that never reached the agent’s inbox is no step of its, even where its catch-up showed it as
// background. Tokens and cost come from the work ledger (tools/atif-metrics.mjs). The run clock’s events are no steps,
// since the agent saw only its line in a prompt: they go in the trajectory’s extra (tools/atif-clock.mjs).

import { CALL_KINDS, callsOf, questionsOf, WORK_KINDS } from './atif-calls.mjs';
import { CLOCK_WORDS, clockScope } from './atif-clock.mjs';
import { finalMetrics, meter } from './atif-metrics.mjs';
import { placePrompts, promptedTurns, promptSteps, scopeOf, unresolvedGuides } from './atif-prompts.mjs';
import { agentSessions, recordedCalls, withCalls } from './atif-streams.mjs';
import { iso } from './atif-time.mjs';

export { NOT_RECORDED, NOT_RECORDED_WITHOUT_PROMPTS } from './atif-prompts.mjs';

/** @typedef {{ seq: number, type: string, data: any }} Event */

/** The items an agent session shows: each is one of its steps. */
const OWN_KINDS = new Set(['agent', 'block', 'app']);

/**
 * The events folded into what the trajectories read: each item as it ended, in the order it was added, each step of a
 * reply with the most it ever carried, the sessions, each inbox’s entries, the ledger’s turns and calls, and the clock
 * events, in order, with prompts.jsonl’s rows placed among them.
 * @param {Event[]} events @param {any[]} live  live frames, for the steps’ input and output @param {any[]} prompts  prompts.jsonl’s rows
 */
export function foldEvents(events, live = [], prompts = []) {
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
  // In the order they happened: by the recorder’s epoch (tools/uat/history.mjs: a restart numbers from lower again), then by seq.
  // Each event’s place is its position once sorted, which every step, turn and model report is ordered by: a seq alone
  // isn’t one, since a new epoch numbers from lower again.
  const sorted = [...events].sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0) || a.seq - b.seq);
  for (const [place, e] of sorted.entries()) foldOne(f, { ...e, seq: place });
  // A live step frame carries what changed of one step; a snapshot frame, a running turn’s steps as a page joins it.
  for (const l of live) {
    if (l?.kind === 'step') mergeStep(f.items.get(l.itemId), l.step ?? {});
    if (l?.kind === 'snapshot') for (const s of l.steps ?? []) mergeStep(f.items.get(l.itemId), s);
  }
  placePrompts(f, prompts);
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
  else if (e.type === 'work.add' && WORK_KINDS.has(d.entry?.kind)) f.work.set(d.entry.id, { ...d.entry, from: e.seq });
  else if (e.type === 'work.patch' && f.work.has(d.id)) {
    const w = f.work.get(d.id);
    // The output a call ended with, kept apart from the job's a background command's may be replaced with later (#1757).
    if (d.patch?.output && !d.patch.endedInBackground) w.callOutput = d.patch.output;
    Object.assign(w, d.patch, d.patch?.endedAt ? { to: e.seq } : {});
  } else if (Object.hasOwn(CLOCK_WORDS, e.type)) f.clocks.push({ seq: e.seq, type: e.type, data: d });
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
 * final state. @param {any} f @param {string} sessionId @param {any} e @param {number} seq
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
  const { tool_calls, results, thoughts, narration } = callsOf(it, ctx.calls, ctx.questions, ctx.blob, ctx.recorded);
  const metrics = ctx.meter.take(it.turnId);
  return {
    source: 'agent',
    message: it.text ?? '',
    ...modelFields(ctx, seq, it.turnId),
    ...(thoughts.length ? { reasoning_content: thoughts.join('\n\n') } : {}),
    ...(tool_calls.length ? { tool_calls } : {}),
    ...(results.length ? { observation: { results } } : {}),
    ...(metrics ? { metrics } : {}),
    extra: {
      item_id: it.id,
      turn_id: it.turnId ?? null,
      status: it.status ?? null,
      ...(it.stopReason ? { stop_reason: it.stopReason } : {}),
      ...(narration.length ? { narration } : {}),
    },
  };
}

/**
 * A block or app the agent showed, and the person’s answer to it. Showing it took no model call of its own: the call
 * that made it is in a reply, so the step says `llm_call_count: 0`, and carries no model or tokens. An AskUserQuestion’s
 * block is its call’s (server/ask-question.mjs): no step, and its answer, which the call’s result carries when the call
 * took it at once (`read`), is none either.
 * @param {any} it @param {any} ctx
 */
function shownSteps(it, ctx) {
  const asked = it.question === true && ctx.questions.has(it.toolUseId);
  const shown = asked
    ? []
    : [
        {
          timestamp: iso(it.at),
          source: 'agent',
          message: it.block?.fallback ?? it.title ?? '',
          llm_call_count: 0,
          extra: { item_id: it.id, turn_id: it.turnId ?? null, kind: it.kind, block_type: it.block?.type ?? null },
        },
      ];
  const a = it.answer;
  if (!a || typeof a.at !== 'number' || (asked && a.read === true)) return shown;
  // An answer reached the agent when its call took it at once (an AskUserQuestion, `read`), or when one of its turns
  // took the answer’s entry from its inbox (server/blocks.mjs): one that only waits there, as after its clock expired, didn’t.
  const entry = ctx.delivered.get(it.id);
  if (a.read !== true && entry?.source !== 'answer') return shown;
  // An answer a turn took from the inbox is in that turn’s prompt, when it’s recorded.
  if (a.read !== true && carry(ctx, entry, { item_id: it.id, entry_id: entry.entryId, answer_to: it.block?.id ?? null })) return shown;
  const answer = {
    timestamp: iso(a.at),
    source: 'user',
    message: `${a.action}: ${JSON.stringify(a.values ?? {})}`,
    extra: { item_id: it.id, answer_to: it.block?.id ?? null, ...(entry ? { entry_id: entry.entryId, taken_by_turn: entry.turnId } : {}) },
    // Placed where its patch came, not beside the block: other steps can come between them.
    seq: it.answerSeq,
  };
  return [...shown, answer];
}

/**
 * The steps one item gives the session’s trajectory, each with when it happened.
 * @param {any} it @param {any} ctx @param {number} seq  where in the events it was added
 */
function itemSteps(it, ctx, seq) {
  const mine = it.sessionId === ctx.sessionId;
  if (it.kind === 'agent' && mine) return [{ timestamp: iso(it.at), ...replyStep(it, ctx, seq) }];
  if ((it.kind === 'block' || it.kind === 'app') && mine) return shownSteps(it, ctx);
  // Someone else’s words are a step only when they reached this agent’s inbox.
  const entry = ctx.delivered.get(it.id);
  if (!entry) return [];
  const got = { item_id: it.id, entry_id: entry.entryId, taken_by_turn: entry.turnId ?? null };
  const text = entry.text ?? it.text ?? '';
  if (carry(ctx, entry, { item_id: it.id, entry_id: entry.entryId, ...(it.kind === 'agent' ? { from: it.handle } : {}), text })) return [];
  if (it.kind === 'user') return [{ timestamp: iso(it.at), source: 'user', message: text, extra: got }];
  if (it.kind === 'agent') return [{ timestamp: iso(it.at), source: 'system', message: `@${it.handle}: ${text}`, extra: { ...got, from: it.handle } }];
  return [];
}

/**
 * Notes what a turn took as the provenance of its recorded prompt, which carried it, and says whether it did: then the
 * item is no step of its own. @param {any} ctx @param {any} entry  its take @param {any} what
 */
function carry(ctx, entry, what) {
  if (!entry?.turnId || !ctx.prompted.has(entry.turnId)) return false;
  ctx.carried.set(entry.turnId, [...(ctx.carried.get(entry.turnId) ?? []), what]);
  return true;
}

/**
 * The context one session’s steps are built in.
 * @param {ReturnType<typeof foldEvents>} f @param {string} sessionId @param {(sha256: string) => string | null} [blob]
 * @param {{ handle: string, started?: number, events: any[] }[]} [streams]  the turns’ recorded streams (tools/atif-streams.mjs)
 */
function contextOf(f, sessionId, blob = () => null, streams = []) {
  const handle = f.sessions.get(sessionId)?.handle ?? null;
  const turns = new Map([...f.work.values()].filter((w) => w.kind === 'turn' && w.sessionId === sessionId).map((w) => [w.id, w]));
  // Its own calls only: a tool call's id is its backend's, so another session's call can carry the same one.
  const calls = new Map([...f.work.values()].filter((w) => CALL_KINDS.has(w.kind) && w.toolUseId && w.sessionId === sessionId).map((w) => [w.toolUseId, w]));
  // Taken by one of its turns, as it was when taken: an entry still waiting (sent after its clock expired, say) never
  // reached the agent, and one taken and given back by a retry did (noteTake).
  const delivered = new Map([...f.takes.values()].filter((t) => t.sessionId === sessionId).map((t) => [t.itemId, t]));
  // A turn whose prompt is recorded carries what it took as its prompt’s provenance, not as steps of their own.
  return {
    sessionId,
    turns,
    calls,
    delivered,
    questions: questionsOf(f, sessionId),
    prompted: promptedTurns(f, sessionId),
    carried: new Map(),
    models: f.models.get(sessionId) ?? [],
    meter: meter(turns),
    blob,
    recorded: recordedCalls(streams, handle, agentSessions(f, handle), sessionId),
  };
}

/**
 * One agent session’s trajectory, or null when the events give it no step.
 * @param {ReturnType<typeof foldEvents>} f @param {string} sessionId
 * @param {{ version: string, blob?: (sha256: string) => string | null, streams?: { handle: string, events: any[] }[] }} opts  blob: a stored blob's text, for outputs; streams: the turns' recorded streams (tools/atif-streams.mjs)
 */
export function trajectoryOf(f, sessionId, { version, blob, streams }) {
  const se = f.sessions.get(sessionId) ?? {};
  const ctx = contextOf(f, sessionId, blob, streams);
  /** @type {{ seq: number, steps: any[] }[]} */
  // A step that brings its own place (an answer, at its patch) goes there; the rest go where their item was added.
  const placed = f.order.flatMap(({ seq, id }) =>
    itemSteps(f.items.get(id), ctx, seq).map(({ seq: own, ...step }) => ({ seq: typeof own === 'number' ? own : seq, steps: [step] })),
  );
  const clocks = f.clocks.filter((x) => x.data.sessionId === sessionId);
  const prompts = promptSteps(f, sessionId, ctx.carried);
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
    ...withCalls(withClock(scopeOf(prompts.length > 0, unresolvedGuides(f, sessionId)), clockScope(clocks)), ctx.recorded),
    steps,
    final_metrics: finalMetrics(ctx.turns, ctx.meter.metered, steps.length),
  };
}

/** A trajectory’s scope, with its clock’s (tools/atif-clock.mjs). @param {{ notes: string, extra: any }} scope @param {{ note: string|null, extra: any }} clock */
const withClock = (scope, clock) => ({ notes: clock.note ? `${clock.note} ${scope.notes}` : scope.notes, extra: { ...scope.extra, ...clock.extra } });

/**
 * Every agent session’s trajectory in the events, or only `sessionId`’s.
 * @param {Event[]} events @param {{ version: string, live?: any[], prompts?: any[], sessionId?: string, blob?: (sha256: string) => string | null, streams?: { handle: string, events: any[] }[] }} opts
 *   prompts: prompts.jsonl’s rows; blob: a stored blob's text, for the outputs live frames don't carry
 * @returns {{ sessionId: string, handle: string|null, trajectory: any }[]}
 */
export function trajectories(events, { version, live = [], prompts = [], sessionId, blob, streams = [] }) {
  const f = foldEvents(events, live, prompts);
  // Every session that showed something: a reply, a block or an app, so one whose only output was a block has one too.
  const ids = new Set([...f.items.values()].filter((it) => OWN_KINDS.has(it.kind) && it.sessionId).map((it) => it.sessionId));
  for (const c of f.clocks) ids.add(c.data.sessionId);
  return [...ids]
    .filter((id) => !sessionId || id === sessionId)
    .map((id) => ({ sessionId: id, trajectory: trajectoryOf(f, id, { version, blob, streams }) }))
    .filter((x) => x.trajectory)
    .map((x) => ({ ...x, handle: x.trajectory.agent.extra.handle }));
}
