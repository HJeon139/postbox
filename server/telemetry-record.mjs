// What a telemetry report records of a room (designs/telemetry-persona.md, R12): its structure as Postbox’s own values,
// counts, durations and refs, from its state and what server/telemetry.mjs recorded. No text from the room goes in it.
// Refs are Postbox’s ordinals over the whole room (i3 for the room’s third message, block or app, t2 for its second
// turn), so a ref means the same thing with the history or without it; the map back to Postbox’s ids stays local
// (tier L, R15).

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BACKENDS, bucket, MODELS, OUTCOMES, TOOL_CLASSES } from '../shared/telemetry-vocab.mjs';
import { freshInstall } from './seed.mjs';
import { lostOf, readLines, running } from './telemetry.mjs';
import { callClass, turnStats } from './telemetry-streams.mjs';

const WOKE = { user: 'person', agent: 'wake', event: 'answer', wake: 'schedule', lint: 'postbox', 'app-check': 'postbox' };
const SAID = new Set(['user', 'agent', 'block']);

/** The conversation and its side and topic threads. */
export const roomThreads = (rt, conv) => rt.conversationThreads(conv.id);

/**
 * Everything the report is built from, with refs. history: include what happened before recording started (R2).
 * @param {any} rt @param {any} conv @param {string} dir  its recording folder @param {{ history?: boolean }} [opts]
 */
export function collect(rt, conv, dir, { history = false } = {}) {
  const since = history ? 0 : (conv.recording?.since ?? 0);
  const threads = roomThreads(rt, conv);
  const all = threads.flatMap((id) => rt.store.items(id).map((it) => ({ ...it, threadId: id }))).sort((a, b) => a.at - b.at);
  const items = all.filter((it) => it.at >= since);
  /** @type {Map<string, { kind: string, id: string }>} ref → what it stands for (local only) */
  const local = new Map();
  const byItem = new Map();
  let n = 0;
  for (const it of all.filter((x) => SAID.has(x.kind))) {
    const ref = `i${++n}`;
    if (it.at < since) continue;
    byItem.set(it.id, ref);
    local.set(ref, { kind: 'item', id: it.id });
  }
  const sessions = threads.flatMap((id) => rt.s.threads[id]?.members ?? []).map((id) => rt.s.sessions[id]);
  const agents = agentsOf(rt, sessions.filter(Boolean));
  const every = turnsOf(rt, dir, all, conv.recording?.since ?? 0, agents);
  const numbers = new Map(every.map((t, i) => [t.turnId, `t${i + 1}`]));
  const turns = history ? every : every.filter((t) => !t.before);
  const byTurn = new Map(turns.map((t) => [t.turnId, /** @type {string} */ (numbers.get(t.turnId))]));
  for (const [id, ref] of byTurn) local.set(ref, { kind: 'turn', id });
  return { conv, dir, since, history, threads, items, local, byItem, byTurn, agents, turns };
}

/**
 * The room’s agents as pseudonyms (R12, Agent): a boilerplate’s name when both the handle and the instructions are that
 * boilerplate’s, unchanged; otherwise agent-1, agent-2…. Backend and model are Postbox’s, or “other”.
 */
function agentsOf(rt, sessions) {
  const fresh = freshInstall().personas;
  /** @type {Map<string, any>} */
  const out = new Map();
  let k = 0;
  for (const se of sessions) {
    if (out.has(se.personaId)) continue;
    const p = rt.persona(se.personaId) ?? {};
    const same = fresh.find((b) => b.handle === p.handle && b.instructions === p.instructions);
    out.set(se.personaId, {
      id: same ? same.handle : `agent-${++k}`,
      backend: BACKENDS.includes(p.backend) ? p.backend : 'other',
      model: MODELS.includes(p.model) ? p.model : 'other',
      effort: p.effort ?? null,
      permissionMode: p.permissionMode ?? 'auto',
      tools: [...(p.tools ?? [])].sort(),
      hostSetup: p.usesHostSetup !== false,
      mcpServers: Array.isArray(se.mcpServers?.servers) ? se.mcpServers.servers.length : 0,
    });
  }
  return out;
}

/**
 * Every agent turn, oldest first: those recorded (turns.jsonl, with their streams), and those the room’s items show that
 * weren’t, before recording started or not caught. A turn still running has half a stream: it’s a gap until it ends.
 */
function turnsOf(rt, dir, all, since, agents) {
  const recorded = new Map(readLines(join(dir, 'turns.jsonl')).map((t) => [t.turnId, t]));
  const out = [];
  for (const r of recorded.values()) {
    const live = running(rt, r);
    const events = live ? [] : readLines(join(dir, r.stream));
    // When it last wrote is when it ended (R7).
    const file = join(dir, r.stream);
    const last = events.length && existsSync(file) ? statSync(file).mtimeMs : null;
    const lost = lostOf(rt).turns.has(r.turnId);
    out.push({ ...r, running: live, lost, recorded: events.length > 0 && !lost, events, endedAt: last, agent: agents.get(r.personaId)?.id ?? 'agent-1' });
  }
  const shown = new Map();
  for (const it of all)
    if (it.turnId && (it.kind === 'agent' || it.kind === 'block') && !recorded.has(it.turnId) && !shown.has(it.turnId)) shown.set(it.turnId, it);
  for (const [turnId, it] of shown) {
    const se = rt.s.sessions[it.sessionId];
    out.push({
      turnId,
      sessionId: it.sessionId,
      startedAt: it.at,
      recorded: false,
      before: it.at < since,
      events: [],
      agent: agents.get(se?.personaId)?.id ?? 'agent-1',
    });
  }
  for (const t of out) t.status = statusOf(all, t.turnId);
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

const statusOf = (all, turnId) => {
  const mine = all.filter((x) => x.turnId === turnId && x.kind === 'agent');
  return mine.some((x) => x.status === 'failed') ? 'failed' : mine.some((x) => x.status === 'stopped') ? 'stopped' : mine.length ? 'done' : 'unknown';
};

/**
 * Tier A (R12): the room, its agents, turns, permission prompts, blocks, work, reactions and the gaps.
 * @param {any} rt @param {ReturnType<typeof collect>} c
 */
export function tierA(rt, c) {
  const items = c.items;
  const turns = c.turns.map((t) => turnRow(c, t));
  const gaps = c.turns
    .filter((t) => !t.recorded)
    .map((t) => ({
      kind: 'no-stream',
      turn: c.byTurn.get(t.turnId),
      reason: t.before ? 'before-recording' : t.running ? 'running' : t.lost ? 'write-failed' : 'not-recorded',
    }));
  const wakes = items.filter((x) => x.kind === 'system' && x.variant === 'wake' && x.from !== 'you' && !x.scheduled);
  const others = c.threads.map((id) => rt.s.threads[id]).filter((t) => t && t.id !== c.conv.id);
  return {
    room: {
      kind: (rt.s.threads[c.conv.id]?.members ?? []).length > 1 ? 'room' : 'dm',
      agents: c.agents.size,
      personMessages: items.filter((x) => x.kind === 'user').length,
      turns: turns.length,
      sideThreads: others.filter((t) => t.kind === 'side').length,
      topicThreads: others.filter((t) => t.kind === 'topic').length,
      wakeChains: wakes.filter((x) => (x.n ?? 1) === 1).length,
      longestWakeChain: Math.max(0, ...wakes.map((x) => x.n ?? 1)),
      hopConfirms: items.filter((x) => x.kind === 'hop').length,
      compactions: items.filter((x) => x.kind === 'system' && x.variant === 'compaction').length,
      initiativeEntropy: entropy(turns.map((t) => t.woke)),
    },
    agents: [...c.agents.values()],
    turns,
    prompts: items
      .filter((x) => x.kind === 'permission')
      .map((x) => ({
        turn: c.byTurn.get(x.turnId) ?? null,
        tool: callClass(x.tool, x.input),
        mode: rt.persona(rt.s.sessions[x.sessionId]?.personaId)?.permissionMode ?? 'auto',
        outcome: OUTCOMES.includes(x.status) ? x.status : 'open',
        waitMs: x.answeredAt ? x.answeredAt - x.at : null,
      })),
    blocks: items.filter((x) => x.kind === 'block' && x.valid).map((x) => blockRow(rt, c, x)),
    work: workOf(rt, c),
    reactions: reactionsOf(c),
    gaps: [
      ...gaps,
      ...(lostOf(rt).events.has(c.conv.id) ? [{ kind: 'events', reason: 'write-failed' }] : []),
      ...(lostOf(rt).sweep ? [{ kind: 'sweep', reason: 'write-failed' }] : []),
    ],
  };
}

function turnRow(c, t) {
  const s = t.recorded ? turnStats(t.events, t.startedAt) : null;
  const tools = s ? Object.fromEntries(Object.entries(s.tools).filter(([k]) => TOOL_CLASSES.includes(k))) : undefined;
  return {
    ref: c.byTurn.get(t.turnId),
    agent: t.agent,
    woke: WOKE[t.kind] ?? (t.recorded ? 'postbox' : 'unknown'),
    recorded: t.recorded,
    wallMs: t.endedAt && t.startedAt ? Math.round(t.endedAt - t.startedAt) : null,
    ...(s ? { ...s, tools } : {}),
    ended: t.running ? 'unknown' : t.status,
  };
}

const blockRow = (rt, c, x) => ({
  ref: c.byItem.get(x.id),
  type: x.block.type,
  revisions: x.revision ?? 1,
  answered: !!x.answered,
  answerMs: x.answer?.at ? x.answer.at - x.at : null,
  ...(x.block.type === 'app'
    ? { versions: rt.s.apps[x.block.id]?.versions?.length ?? 1, checkFailures: rt.s.apps[x.block.id]?.check?.problems?.length ?? 0 }
    : {}),
});

/** Each reaction in the report’s span, on the ref it’s on, with the time from the item to it: the time to detect (R9). */
function reactionsOf(c) {
  const out = [];
  for (const it of c.items)
    for (const r of it.reactions ?? [])
      if (c.byItem.has(it.id) && r.at >= c.since) out.push({ emoji: r.emoji, on: c.byItem.get(it.id), detectMs: Math.max(0, r.at - it.at), at: r.at });
  return out.sort((a, b) => a.at - b.at).map(({ at: _a, ...r }, i) => ({ ref: `r${i + 1}`, ...r }));
}

const entropy = (list) => {
  if (!list.length) return 0;
  const n = new Map();
  for (const x of list) n.set(x, (n.get(x) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / list.length) * Math.log2(k / list.length);
  return Math.round(h * 1000) / 1000;
};

/** Files and lines changed in log buckets, never names (R12, Work). */
function workOf(rt, c) {
  const entries = (rt.s.work?.[c.conv.id] ?? []).filter((e) => (e.at ?? e.startedAt ?? 0) >= c.since);
  const files = entries.filter((e) => e.kind === 'file');
  const commands = entries.filter((e) => e.kind === 'command');
  return {
    files: bucket(new Set(files.map((e) => e.path)).size),
    lines: bucket(files.reduce((n, e) => n + (e.added ?? 0) + (e.deleted ?? 0), 0)),
    commands: commands.length,
    commits: entries.filter((e) => e.kind === 'commit').length,
    pushes: commands.filter((e) => /\bgit\s+push\b/.test(String(e.command ?? ''))).length,
  };
}
