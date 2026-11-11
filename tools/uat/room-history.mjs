// What the P0 hotfixes’ checks (#108, #123, #125, #126; tools/uat/room-checks-p0.mjs) read of a run’s history. Read
// from what main already records: the items in Postbox’s state, the event history (facts.events), each turn’s raw
// stream with its file’s times, and what the runner saw when it answered a block (facts.probes.answers). Where a fix
// adds a field that says it outright (a hop’s full text, the revision an answer was for, a background job’s record),
// the check reads it when it’s there. Moved out of tools/uat/room-checks.mjs, for size.

import { POSTBOX_SERVER } from '../../server/adapters/setup.mjs';
import { toPlainText } from '../../shared/markdown.mjs';
import { itemsOf } from './room-items.mjs';

const BUSY = new Set(['think', 'tool', 'gen']);
// Clocks and file times differ by a few milliseconds; a second is far below the defects’ own scale (90 s, #126).
export const SLACK_MS = 1000;
export const secs = (ms) => `${Math.round(ms / 1000)} s`;
const timeOf = (ts) => {
  const n = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
// A wake request’s preview, made the way Postbox makes it (server/runtime.mjs, clip): plain text, 200 characters.
export const clip200 = (s) => {
  const t = toPlainText(s);
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
};
export const clock = (ms) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
/**
 * When a turn’s process started (its stream file is named for it), and the last time it did anything: its newest
 * message, or the file’s last write when no message carries a time.
 * @param {{ events: any[], started?: number, ended?: number }} s
 */
export function streamSpan(s) {
  /** @type {number|null} */
  let last = null;
  /** @type {number|null} */
  let first = null;
  for (const e of s.events) {
    if (e?.type !== 'assistant' && e?.type !== 'user') continue;
    const t = timeOf(e.timestamp);
    if (t === null) continue;
    if (last === null || t > last) last = t;
    if (first === null || t < first) first = t;
  }
  return {
    start: Number.isFinite(s.started) ? /** @type {number} */ (s.started) : first,
    last: last ?? (Number.isFinite(s.ended) ? /** @type {number} */ (s.ended) : null),
  };
}
/** Tool results by call id, so a call Postbox refused (an error result) can be told from one it applied. */
const resultsOf = (events) =>
  new Map(
    events
      .filter((e) => e?.type === 'user')
      .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
      .filter((b) => b?.type === 'tool_result')
      .map((b) => [b.tool_use_id, b]),
  );
/** The Postbox tool calls a stream made after a moment, that Postbox didn’t refuse. */
export function postboxCallsAfter(events, after) {
  const results = resultsOf(events);
  return (
    events
      .filter((e) => e?.type === 'assistant' && (timeOf(e.timestamp) ?? 0) > after)
      .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []).map((b) => ({ b, at: timeOf(e.timestamp) })))
      // A call with no result never got an answer from Postbox (the process was killed first), so it counts only with one.
      .filter(
        ({ b }) =>
          b?.type === 'tool_use' && String(b.name ?? '').startsWith(`mcp__${POSTBOX_SERVER}__`) && results.has(b.id) && results.get(b.id).is_error !== true,
      )
      .map(({ b, at }) => ({ name: String(b.name).slice(`mcp__${POSTBOX_SERVER}__`.length), at: /** @type {number} */ (at) }))
  );
}

/**
 * Each block’s history from the event log (#123): every answer, with the revision it landed on, and every update that
 * reopened an answered block before the agent had read the answer. An answer reaches an agent at the start of a turn:
 * one given while its turn runs waits for that turn to end. So an update with no new turn of that session since the
 * answer was written without it. A turn starts when the session starts thinking with finishedAt cleared, and ends when
 * finishedAt is set: a permission card mid-turn sets the state to needs, not finishedAt. A fix that marks the answer
 * read (answer.read, #123) is read too. A block that follows the conversation gets its new revision by item.move, with
 * the same patch (#92, #173). A block shown before the history begins (a log that lost its first segment) is skipped.
 * @param {any[]} events
 */
export function blockHistory(events) {
  /** @type {Map<string, boolean>} */
  const inTurn = new Map();
  /** @type {Map<string, number[]>} */
  const turnStarts = new Map();
  /** @type {Map<string, any>} */
  const blocks = new Map();
  const answers = [];
  const reopened = [];
  for (const e of events ?? []) {
    const d = e?.data;
    if (!d) continue;
    if (e.type === 'session') {
      const was = inTurn.get(d.id) ?? false;
      // A history without finishedAt (none on main lacks it) falls back to the state alone.
      const now = d.finishedAt === undefined ? BUSY.has(d.state) : d.finishedAt === null && (was || d.state === 'think');
      if (now && !was) turnStarts.set(d.id, [...(turnStarts.get(d.id) ?? []), e.seq]);
      inTurn.set(d.id, now);
    } else if (e.type === 'item.add' && d.item?.kind === 'block' && d.item.valid) {
      const it = d.item;
      blocks.set(it.id, {
        itemId: it.id,
        threadId: d.threadId,
        sessionId: it.sessionId,
        handle: it.handle,
        blockId: it.block?.id,
        title: it.block?.title ?? it.block?.prompt ?? it.block?.id ?? '',
        revision: it.revision ?? 1,
        answer: null,
      });
    } else if (e.type === 'item.patch' || e.type === 'item.move') {
      const b = blocks.get(d.id);
      const p = d.patch ?? {};
      if (!b) continue;
      if (p.answered === true && p.answer) {
        // A fix that records the revision the person saw puts it on the answer (#123).
        const saw = Number.isFinite(p.answer.revision) ? p.answer.revision : null;
        b.answer = { seq: e.seq, at: p.answer.at ?? null, action: p.answer.action ?? 'answer', revision: b.revision, saw, read: p.answer.read === true };
        answers.push({ ...b.answer, itemId: b.itemId, threadId: b.threadId, handle: b.handle, title: b.title });
      } else if (p.answer?.read === true && b.answer) b.answer.read = true;
      if (Number.isFinite(p.revision)) {
        if (p.answered === false && b.answer) {
          const read = b.answer.read || (turnStarts.get(b.sessionId) ?? []).some((s) => s > b.answer.seq && s < e.seq);
          if (!read)
            reopened.push({
              itemId: b.itemId,
              threadId: b.threadId,
              handle: b.handle,
              title: b.title,
              revision: p.revision,
              answer: b.answer,
              ms: Number.isFinite(p.updatedAt) && Number.isFinite(b.answer.at) ? p.updatedAt - b.answer.at : null,
            });
        }
        if (p.answered === false) b.answer = null;
        b.revision = p.revision;
      }
    }
  }
  return { answers, reopened };
}

/**
 * The messages agents sent other agents, as they wrote them: each wake_agent call in their streams, and each turn’s
 * reply (an @-mention in it wakes the agent it names).
 * @param {any} f
 */
export function wakesSent(f) {
  const calls = (f.streams ?? []).flatMap(({ handle, events }) =>
    events
      .filter((e) => e?.type === 'assistant')
      .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
      .filter((b) => b?.type === 'tool_use' && b.name === `mcp__${POSTBOX_SERVER}__wake_agent`)
      .map((b) => ({ from: handle, to: String(b.input?.handle ?? '').replace(/^@/, ''), text: String(b.input?.message ?? '') })),
  );
  /** @type {Map<string, { from: string, to: null, text: string }>} */
  const turns = new Map();
  for (const it of itemsOf(f))
    if (it.kind === 'agent' && it.turnId && it.text) {
      const t = turns.get(it.turnId);
      turns.set(it.turnId, { from: it.handle, to: null, text: t ? `${t.text}\n\n${it.text}` : it.text });
    }
  return [...calls, ...turns.values()];
}

// A background job’s end, as Claude Code’s stream reports it (task_updated’s patch.status, task_notification).
const JOB_ENDED = /^(completed|failed|killed|stopped|cancelled|canceled|done|exited|error)$/i;
/**
 * The background Bash calls a turn’s stream made, by tool call id, and whether the stream says each one ended: a call
 * with run_in_background, or a command Claude Code moved to the background (task_updated is_backgrounded, or a result
 * that names a backgroundTaskId). Monitors and subagents aren’t background commands.
 * @param {any[]} events
 */
export function backgroundJobs(events) {
  /** @type {Map<string, string>} */
  const toolOfTask = new Map();
  /** @type {Map<string, { id: string, task: string|null, command: string, ended: boolean }>} */
  const jobs = new Map();
  const job = (id) => {
    if (!jobs.has(id)) jobs.set(id, { id, task: null, command: '', ended: false });
    return /** @type {{ id: string, task: string|null, command: string, ended: boolean }} */ (jobs.get(id));
  };
  /** @type {Map<string, string>} */
  const commands = new Map();
  const ended = new Set();
  /** @type {Set<string>} */
  let listed = new Set();
  for (const e of events) {
    if (e?.type === 'assistant')
      for (const b of Array.isArray(e.message?.content) ? e.message.content : [])
        if (b?.type === 'tool_use' && b.name === 'Bash') {
          commands.set(b.id, String(b.input?.command ?? b.input?.description ?? ''));
          if (b.input?.run_in_background === true) job(b.id);
        }
    if (e?.type === 'user') {
      const r = e.tool_use_result;
      const ids = (Array.isArray(e.message?.content) ? e.message.content : []).filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id);
      if (r && typeof r === 'object' && typeof r.backgroundTaskId === 'string' && ids.length === 1 && commands.has(ids[0])) {
        job(ids[0]).task = r.backgroundTaskId;
        toolOfTask.set(r.backgroundTaskId, ids[0]);
      }
    }
    if (e?.type !== 'system') continue;
    if (e.subtype === 'task_started' && e.task_id && e.tool_use_id && (e.task_type ?? 'local_bash') === 'local_bash') {
      toolOfTask.set(e.task_id, e.tool_use_id);
      if (e.is_backgrounded === true) job(e.tool_use_id).task = e.task_id;
    } else if (e.subtype === 'task_updated' && e.task_id) {
      const id = toolOfTask.get(e.task_id);
      if (id && e.patch?.is_backgrounded === true) job(id).task = e.task_id;
      if (id && (JOB_ENDED.test(String(e.patch?.status ?? '')) || Number.isFinite(e.patch?.end_time))) ended.add(id);
    } else if (e.subtype === 'task_notification') {
      const id = e.tool_use_id ?? toolOfTask.get(e.task_id);
      if (id) ended.add(id);
    } else if (e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks)) {
      // A job listed before and gone from the list now has ended.
      const now = new Set(e.tasks.map((t) => t?.task_id).filter(Boolean));
      for (const t of listed) if (!now.has(t) && toolOfTask.has(t)) ended.add(/** @type {string} */ (toolOfTask.get(t)));
      listed = now;
    }
  }
  for (const j of jobs.values()) {
    j.command = commands.get(j.id) ?? '';
    j.ended = ended.has(j.id);
  }
  return [...jobs.values()];
}
/**
 * A fix’s own record of a background job (#126 tracks each one with its id, command and output file), matched by the
 * tool call id or the background id, wherever it keeps them: the state’s jobs, or a session’s. Null when there’s none.
 * @param {any} state  @param {{ id: string, task: string|null }} j
 * @returns {{ ended: boolean } | null}
 */
export function jobRecord(state, j) {
  const lists = [state?.jobs, state?.backgroundJobs, ...Object.values(state?.sessions ?? {}).flatMap((se) => [se?.jobs, se?.backgroundJobs])];
  for (const list of lists) {
    const all = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : [];
    for (const r of all) {
      if (!r || typeof r !== 'object') continue;
      const ids = [r.id, r.toolUseId, r.tool_use_id, r.callId, r.taskId, r.task_id, r.backgroundId, r.backgroundTaskId];
      if (!ids.includes(j.id) && !(j.task && ids.includes(j.task))) continue;
      const status = String(r.status ?? r.state ?? '');
      return { ended: JOB_ENDED.test(status) || Number.isFinite(r.endedAt) || Number.isFinite(r.exitedAt) || Number.isFinite(r.end_time) };
    }
  }
  return null;
}
