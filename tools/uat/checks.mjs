// Deterministic checks the UAT runs alongside the tester. Each looks for one kind of defect in what the run
// collected and names the GitHub issue it reproduces, so a run’s report says which known issues it caught.
// They’re pure functions over `facts` (gathered by tools/uat-run.mjs), so tests can feed them fixtures.
//
// facts = {
//   state,           Postbox’s /api/state at the time
//   threads,         ids of the conversations and topic threads under test
//   startPersonas,   the personas a fresh install had
//   streams,         [{ handle, events, started, ended }]: each real turn’s raw stream (POSTBOX_CLAUDE_RECORD), with
//                    when its file was started (its name) and last written, in ms
//   events,          Postbox’s events for items and sessions, in order (tools/uat/history.mjs), for the checks that
//                    need what happened, not only the state now
//   kiroStreams,     [{ handle, events }]: each Kiro CLI turn’s raw stream (POSTBOX_KIRO_RECORD), kept apart: its
//                    lines are { type, data } around ACP session updates, which the Claude Code checks don’t read
//   agyStreams,      [{ handle, events }]: each Antigravity CLI turn’s raw stream (POSTBOX_AGY_RECORD), in a release
//                    run only: its lines are { event } (init, step_update, result)
//   transcripts,     [{ handle, lines }]: each agent’s Claude Code transcript, as text lines
//   console,         the page’s console errors and exceptions
//   apps,            { [itemId]: { text, marks, tinyMarks, svgText, tinyText, fonts } } read from inside each app
//   probes,          { fullScreen: [{ key, before, after, viewport }], attachments: [{ key, images, attachments }],
//                    answers: [{ key, revision, at }]: the revision of a block the runner read just before answering it }
//   samples,         [{ busy: [handles thinking or calling tools], rows: number }]: the working row while agents worked
//   ui,              { headerText, reviewRawRows: { [itemId]: rows of a review block shown as raw “| … |” text } }
//   userMcpServers,  names of MCP servers in the person’s own Claude Code config
//   userRulesMarker, a line from the person’s global CLAUDE.md. Since #57, agents load the person’s setup on
//                    purpose, so it reaching them isn’t a finding; no check uses it now.
// }

import { REFUSED as AGY_REFUSED, AGY_SERVER, stepId as agyStepId } from '../../server/adapters/antigravity-cli.mjs';
import { deniedTools, isPublishingTool, POSTBOX_SERVER, PUBLISHING_TOOLS } from '../../server/adapters/setup.mjs';
import { freshInstall } from '../../server/seed.mjs';
import { ASKING } from '../../shared/catalog.mjs';
import { toPlainText } from '../../shared/markdown.mjs';
import { asksInProse, blockUseTally } from './block-use.mjs';
import { isolated, KIRO_KIND_TOOL, kiroTurns } from './checks-kiro.mjs';

export { callsFor, LONG_TURN_MS, LONG_TURN_TOOLS } from './block-use.mjs';
export { kiroCredits } from './checks-kiro.mjs';

const itemsOf = (facts) => facts.threads.flatMap((t) => (facts.state.items[t] ?? []).map((it) => ({ ...it, threadId: t })));
const clip = (s, n = 240) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ── Antigravity CLI turns (#143), in release runs ───────────────────────────────────────────────────
// What each Antigravity turn’s stream says about its tool steps, for the checks below: one entry per step, under the
// id Postbox gives it, with agy’s tool name, the MCP server it called (null for agy’s own tools), whether it ran and
// whether agy refused it. A refusal is a step that ended in ERROR with agy’s refusal wording, or a step the result’s
// denied_actions names that ended DONE with no output (recorded: auto mode unavailable for the account). Read the
// way server/adapters/antigravity-cli.mjs reads a live turn, but from the stream alone.
function agyCalls(events) {
  /** @type {Map<string, { id: string, name: string, title: string, server: string|null, completed: boolean, refused: boolean, output: boolean }>} */
  const calls = new Map();
  for (const e of events) {
    if (e?.event === 'result') {
      for (const a of Array.isArray(e.result?.denied_actions) ? e.result.denied_actions : []) {
        const name = String(a?.display_name ?? '')
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .toLowerCase();
        const c = [...calls.values()].reverse().find((x) => x.name === name && x.completed && !x.output);
        if (c) Object.assign(c, { completed: false, refused: true });
      }
      continue;
    }
    const st = e?.event === 'step_update' ? e.step_update : null;
    if (st?.step_type !== 'tool') continue;
    const id = agyStepId(st);
    const p = st.tool_info?.parameters ?? {};
    const name = String(st.tool_name ?? st.tool_info?.name ?? '');
    if (!calls.has(id))
      calls.set(id, {
        id,
        name,
        title: name === 'call_mcp_tool' ? `${p.ToolName} (${p.ServerName})` : `${name} ${p.CommandLine ?? p.Url ?? p.Path ?? ''}`.trim(),
        server: name === 'call_mcp_tool' ? String(p.ServerName ?? '') || null : null,
        completed: false,
        refused: false,
        output: false,
      });
    const c = /** @type {any} */ (calls.get(id));
    if (st.state === 'DONE') Object.assign(c, { completed: true, output: st.tool_info?.output !== undefined });
    if (st.state === 'ERROR' && AGY_REFUSED.test(String(st.tool_info?.error?.message ?? ''))) c.refused = true;
  }
  return [...calls.values()];
}
/** The tokens Antigravity used over a run’s turns: each model call’s, from its agent_response step. A result’s
 * usage counts the whole conversation so far, so it isn’t added up. */
export const agyTokens = (streams) =>
  streams
    .flatMap(({ events }) =>
      events.map((e) => (e?.event === 'step_update' && e.step_update?.step_type === 'agent_response' ? e.step_update.usage?.total_tokens : null)),
    )
    .filter((n) => Number.isFinite(n))
    .reduce((a, n) => a + n, 0);
/** The Antigravity streams with their persona: only personas on the Antigravity CLI. */
const agyTurns = (f) =>
  (f.agyStreams ?? []).flatMap(({ handle, events }) => {
    const persona = Object.values(f.state.personas ?? {}).find((p) => p.handle === handle && p.backend === 'antigravity-cli');
    return persona ? [{ handle, persona, events, calls: agyCalls(events) }] : [];
  });
// The Tools ids agy’s own tools stand for. agy can’t turn them off for one agent; the agent is only told.
const AGY_TOOL = /** @type {Record<string, string>} */ ({ run_command: 'shell', read_url_content: 'web.fetch', search_web: 'web.fetch' });
/** The ids of the conversation’s refused steps, as Postbox shows them. */
const deniedSteps = (f) =>
  new Set(
    Object.values(f.state.items ?? {})
      .flat()
      .flatMap((it) => it?.activity?.steps ?? [])
      .filter((st) => st.state === 'denied')
      .map((st) => st.id),
  );

/**
 * What’s waiting on the person in these threads, as the “needs you” count sees it: a block that asks (choice,
 * form, confirm, review) and isn’t answered, an open wake request or proposal, and whatever a session says it
 * needs (a permission card, a failed turn to retry). The runner shows it to the tester every step, and doesn’t
 * move on while it’s there, so a run answers what an agent asked instead of leaving it behind.
 * @param {any} state  @param {string[]} threads
 * @returns {{ itemId: string|null, threadId: string, what: string }[]}
 */
export function waitingOnYou(state, threads) {
  /** @type {Map<string, { itemId: string|null, threadId: string, what: string }>} */
  const out = new Map();
  for (const t of threads)
    for (const it of state.items?.[t] ?? []) {
      const by = it.handle ? `@${it.handle}’s ` : '';
      if (it.kind === 'block' && it.valid !== false && ASKING.has(it.block?.type) && !it.answered)
        out.set(it.id, {
          itemId: it.id,
          threadId: t,
          what: `${by}${it.block.type} “${clip(it.block.title ?? it.block.prompt ?? '', 80)}”${it.block.revision ? `, revision ${it.block.revision}` : ''}`,
        });
      else if ((it.kind === 'hop' || it.kind === 'proposal') && it.status === 'open')
        out.set(it.id, { itemId: it.id, threadId: t, what: it.kind === 'hop' ? 'a wake request' : `${by}proposal for a new teammate` });
    }
  for (const t of threads)
    for (const id of state.threads?.[t]?.members ?? []) {
      const se = state.sessions?.[id];
      if (!se?.needs) continue;
      const key = se.needs.itemId ?? `needs:${se.id}`;
      if (!out.has(key)) out.set(key, { itemId: se.needs.itemId ?? null, threadId: se.threadId ?? t, what: clip(se.needs.text ?? se.needs.kind, 120) });
    }
  return [...out.values()];
}

// ── The P0 hotfixes (#108, #123, #125, #126) ───────────────────────────────────────────────────────────
// Read from what main already records: the items in Postbox’s state, the event history (facts.events), each turn’s
// raw stream with its file’s times, and what the runner saw when it answered a block (facts.probes.answers). Where a
// fix adds a field that says it outright (a hop’s full text, the revision an answer was for, a background job’s
// record), the check reads it when it’s there.

const BUSY = new Set(['think', 'tool', 'gen']);
// Clocks and file times differ by a few milliseconds; a second is far below the defects’ own scale (90 s, #126).
const SLACK_MS = 1000;
const secs = (ms) => `${Math.round(ms / 1000)} s`;
const timeOf = (ts) => {
  const n = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
// A wake request’s preview, made the way Postbox makes it (server/runtime.mjs, clip): plain text, 200 characters.
const clip200 = (s) => {
  const t = toPlainText(s);
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
};
const clock = (ms) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
/** The Claude Code session a turn’s stream ran in, from its init. */
const claudeSessionOf = (events) => events.find((e) => e?.type === 'system' && e.subtype === 'init')?.session_id ?? null;
/**
 * When a turn’s process started (its stream file is named for it), and the last time it did anything: its newest
 * message, or the file’s last write when no message carries a time.
 * @param {{ events: any[], started?: number, ended?: number }} s
 */
function streamSpan(s) {
  let last = null;
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
function postboxCallsAfter(events, after) {
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
function wakesSent(f) {
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
function jobRecord(state, j) {
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

/** The checks the runner also runs while agents work, since what they catch can be gone by the time the turn ends. */
export const MID_TURN = ['background-step-closed', 'two-processes-one-session'];

// ── The Agents section, the Work ledger and the right pane (#105, #132, #146) ──────────────────────────────

/** Every tool call in a turn’s stream, with its result when the stream has it. */
const toolCalls = (events) => {
  const results = new Map();
  for (const e of events) if (e.type === 'user') for (const c of e.message?.content ?? []) if (c?.type === 'tool_result') results.set(c.tool_use_id, c);
  const denied = new Set(events.filter((e) => e.type === 'result').flatMap((e) => (e.permission_denials ?? []).map((d) => d.tool_use_id)));
  return events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => (e.message?.content ?? []).filter((c) => c?.type === 'tool_use'))
    .map((c) => ({ id: c.id, name: c.name, input: c.input ?? {}, result: results.get(c.id) ?? null, denied: denied.has(c.id) }));
};
const ledgerEntries = (f) => Object.values(f.state?.work ?? {}).flat();
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** A model as the panel names it (“Opus 5.5”) and as a stream names it (“claude-opus-5-5”), reduced to compare. */
const modelKey = (m) =>
  String(m ?? '')
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/[^a-z0-9]/g, '');

export const CHECKS = [
  {
    id: 'fresh-install-agents',
    issue: 43,
    // What server/seed.mjs gives a fresh install, not the run's agents, which the scenario seeds through
    // agents.json. f.freshInstall replaces it in tests. Generic roles (a researcher, a developer, a critic) are
    // fine; an agent for one use case, such as the demo's book corpus, or a sample project isn't.
    run: (f) => {
      const { personas, projects } = f.freshInstall ?? freshInstall();
      const specific = personas.filter((p) => /corpus|book|gutenberg|index/i.test(`${p.description} ${p.instructions}`));
      if (!specific.length && !projects.length) return [];
      const seeded = [`${personas.length === 1 ? 'one agent' : `${personas.length} agents`} (${personas.map((p) => `@${p.handle}`).join(', ')})`];
      if (projects.length) seeded.push(`${projects.length === 1 ? 'a sample project' : `${projects.length} sample projects`}`);
      return [
        {
          title: 'A fresh install comes with use-case agents',
          evidence: `Seeded: ${seeded.join(' and ')}.${specific.length ? ` Use-case: ${specific.map((p) => `@${p.handle}`).join(', ')}.` : ''}`,
        },
      ];
    },
  },
  {
    // A real agent’s init holding a tool its persona doesn’t allow: an unticked tool, or one that acts outside
    // Postbox’s record (SendMessage, CronCreate…), which wave 1’s UAT saw on every agent. The publishing tools are
    // settings-leak’s. A stream whose persona isn’t in the run’s state is skipped: its ticks aren’t known.
    id: 'tool-not-allowed',
    issue: 5,
    run: (f) => {
      const personas = Object.values(f.state.personas ?? {});
      const hits = f.streams.flatMap(({ handle, events }) => {
        const persona = personas.find((p) => p.handle === handle);
        if (!persona) return [];
        const denied = new Set(deniedTools(persona).filter((r) => !PUBLISHING_TOOLS.includes(r)));
        const tools = events.filter((e) => e.subtype === 'init').flatMap((e) => (Array.isArray(e.tools) ? e.tools : []));
        return [...new Set(tools.filter((x) => denied.has(x)))].map((tool) => ({ handle, tool }));
      });
      return hits.length
        ? [
            {
              title: 'Agents carry tools their persona doesn’t allow',
              evidence: `${[...new Set(hits.map(({ handle }) => `@${handle}`))].join(', ')} had ${[...new Set(hits.map(({ tool }) => tool))].slice(0, 8).join(', ')}.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'hidden-turn-error',
    issue: 61,
    run: (f) =>
      itemsOf(f)
        .filter((it) => it.kind === 'agent' && it.status === 'failed' && /hit an error while running the turn\.?$/.test(it.error ?? ''))
        .map((it) => ({
          key: it.id,
          title: 'A turn failed with no reason given',
          evidence: `@${it.handle} in “${f.state.threads[it.threadId]?.title}”: “${clip(it.error)}”${f.state.threads[it.threadId]?.kind === 'topic' ? ' (a topic thread)' : ''}.`,
        })),
  },
  {
    id: 'failed-turn',
    issue: null,
    run: (f) =>
      itemsOf(f)
        .filter((it) => it.kind === 'agent' && it.status === 'failed' && !/hit an error while running the turn\.?$/.test(it.error ?? ''))
        .map((it) => ({ key: it.id, title: 'A turn failed', evidence: `@${it.handle}: “${clip(it.error)}”.` })),
  },
  {
    id: 'refusal-without-card',
    issue: 65,
    run: (f) => {
      const cards = itemsOf(f).filter((it) => it.kind === 'denial').length;
      const refused = f.streams.flatMap(({ handle, events }) => {
        const listed = events.filter((e) => e.type === 'result').flatMap((e) => e.permission_denials ?? []);
        const declined = new Set(
          events
            .filter((e) => e.type === 'user')
            .flatMap((e) => e.message?.content ?? [])
            .filter((b) => b.type === 'tool_result' && /The person didn’t allow/.test(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)))
            .map((b) => b.tool_use_id),
        );
        return listed.filter((d) => !declined.has(d.tool_use_id)).map((d) => ({ handle, d }));
      });
      return refused.length > cards
        ? [
            {
              title: 'Claude Code refused calls, and Postbox showed no card',
              evidence: `${refused.length} refused, ${cards} cards. ${refused
                .slice(0, 3)
                .map(({ handle, d }) => `@${handle}: ${d.tool_name} ${clip(d.tool_input?.command ?? d.tool_input?.url ?? '', 80)}`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  {
    // Agents load the person’s Claude Code setup by default (#57), so their global CLAUDE.md reaching agents is
    // intended. What must not leak: their output style, and tools that publish outside Postbox for a persona that
    // doesn’t allow them.
    id: 'settings-leak',
    issue: 57,
    run: (f) => {
      const out = [];
      const inits = f.streams.flatMap(({ handle, events }) => events.filter((e) => e.subtype === 'init').map((e) => ({ handle, e })));
      const styles = new Set(inits.filter(({ e }) => e.output_style && String(e.output_style).toLowerCase() !== 'default').map(({ e }) => e.output_style));
      if (styles.size) out.push({ title: 'Agents run with the person’s own output style', evidence: `init output_style: ${[...styles].join(', ')}.` });
      const reminder = f.transcripts.find(({ lines }) => lines.some((l) => /output style is active/i.test(l)));
      if (reminder)
        out.push({
          title: 'The person’s output style is injected into agent turns',
          evidence: `“output style is active” in @${reminder.handle}’s transcript.`,
        });
      const allows = (handle) => Object.values(f.state.personas ?? {}).some((p) => p.handle === handle && p.canPublish === true);
      const publishing = inits.flatMap(({ handle, e }) => (allows(handle) ? [] : (e.tools ?? []).filter(isPublishingTool).map((t) => ({ handle, t }))));
      if (publishing.length)
        out.push({
          title: 'Agents can publish outside Postbox without being allowed to',
          evidence: `${[...new Set(publishing.map(({ handle }) => `@${handle}`))].join(', ')} had ${[...new Set(publishing.map(({ t }) => t))]
            .slice(0, 6)
            .join(', ')}.`,
        });
      return out.length ? [{ title: out.map((o) => o.title).join('; '), evidence: out.map((o) => o.evidence).join(' ') }] : [];
    },
  },
  {
    id: 'mcp-servers-missing',
    issue: 59,
    run: (f) => {
      if (!f.userMcpServers?.length) return [];
      const seen = new Set(
        f.streams.flatMap(({ events }) => events.filter((e) => e.subtype === 'init').flatMap((e) => (e.mcp_servers ?? []).map((s) => s.name))),
      );
      const missing = f.userMcpServers.filter((n) => !seen.has(n));
      return seen.size && missing.length
        ? [
            {
              title: 'Agents can’t use the person’s own MCP servers',
              evidence: `Configured: ${f.userMcpServers.join(', ')}. Agents had: ${[...seen].join(', ')}.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'mcp-side-channel',
    issue: 54,
    run: (f) => {
      const posts = f.streams.flatMap(({ handle, events }) =>
        events
          .filter((e) => e.type === 'assistant')
          .flatMap((e) => e.message?.content ?? [])
          .filter((b) => b.type === 'tool_use' && b.name === 'Bash' && /\/mcp\?session=/.test(b.input?.command ?? ''))
          .map(() => handle),
      );
      return posts.length
        ? [{ title: 'An agent posted to /mcp directly from a script', evidence: `${posts.length} raw POSTs, by @${[...new Set(posts)].join(', @')}.` }]
        : [];
    },
  },
  {
    // Besides a finding per reply that should have been a block, it counts M1’s exit check (#64) over the run: the
    // replies that called for a block, and the ones that used the right one. See tools/uat/block-use.mjs.
    id: 'prose-instead-of-block',
    issue: 63,
    run: (f) => {
      const items = itemsOf(f);
      const turns = new Map();
      /** @type {Map<string, string>} */
      const person = new Map(); // a turn → what the person last wrote before it, in its conversation
      /** @type {Map<string, string>} */
      const said = new Map();
      for (const it of items) {
        if (it.kind === 'user') said.set(it.threadId, it.text ?? '');
        if (!it.turnId || (it.kind !== 'agent' && it.kind !== 'block')) continue;
        if (!turns.has(it.turnId)) person.set(it.turnId, said.get(it.threadId) ?? '');
        turns.set(it.turnId, [...(turns.get(it.turnId) ?? []), it]);
      }
      const out = [];
      const tally = blockUseTally();
      for (const [turnId, list] of turns) {
        const types = list.filter((it) => it.kind === 'block' && it.valid).map((it) => it.block.type);
        const text = list
          .filter((it) => it.kind === 'agent')
          .map((it) => it.text ?? '')
          .join('\n');
        const tail = text.split('\n').slice(-14).join('\n');
        tally.add(list, types, person.get(turnId) ?? '');
        if (types.some((t) => ['choice', 'form', 'review', 'confirm'].includes(t))) continue;
        const asks = asksInProse(text);
        if (asks)
          out.push({
            key: list[0].id,
            title:
              asks === 'draft'
                ? 'A draft to approve was sent as prose, not a review block'
                : 'Questions or options were asked in prose, not a form or choice block',
            evidence: `@${list[0].handle}: “${clip(tail, 200)}”`,
          });
      }
      const counts = tally.finding();
      if (counts) out.push(counts);
      return out;
    },
  },
  {
    id: 'lint-on-person-term',
    issue: 55,
    run: (f) => {
      const items = itemsOf(f);
      const said = items
        .filter((it) => it.kind === 'user')
        .map((it) => it.text ?? '')
        .join('\n')
        .toLowerCase();
      // A term counts only when its agent defined it during a lint turn: agents define terms on their own too.
      const inLintTurn = (t, g) => {
        const mine = items.filter((it) => it.threadId === t && it.kind === 'agent' && it.handle === g.by && it.at <= g.at);
        return mine.at(-1)?.lintReply === true;
      };
      const hits = f.threads.flatMap((t) =>
        Object.values(f.state.glossary?.[t] ?? {})
          .filter((g) => said.includes(String(g.term).toLowerCase()) && inLintTurn(t, g))
          .map((g) => g.term),
      );
      return hits.length
        ? [{ title: 'The term lint made an agent define a term the person introduced', evidence: `Defined after a lint turn: ${hits.join(', ')}.` }]
        : [];
    },
  },
  {
    id: 'topic-relints-parent-term',
    issue: 56,
    run: (f) => {
      const out = [];
      for (const t of f.threads) {
        const th = f.state.threads[t];
        if (th?.kind !== 'topic') continue;
        const parent = new Set(Object.keys(f.state.glossary?.[th.parentId] ?? {}));
        const again = Object.values(f.state.glossary?.[t] ?? {}).filter((g) => parent.has(g.key));
        if (again.length)
          out.push({ key: t, title: 'A topic thread re-defined terms its conversation already had', evidence: again.map((g) => g.term).join(', ') });
      }
      return out;
    },
  },
  {
    id: 'diagram-error-not-fed-back',
    issue: 46,
    run: (f) => {
      const errors = (f.console ?? []).filter((l) => /Diagram: /.test(l));
      return errors.length ? [{ title: 'A diagram failed to draw, and the agent wasn’t told', evidence: clip(errors[0], 200) }] : [];
    },
  },
  {
    id: 'app-shows-missing-data',
    issue: 47,
    run: (f) =>
      Object.entries(f.apps ?? {})
        .filter(([, a]) => /isn[’']t loaded|not loaded|restart postbox|failed to load|no data (?:yet|found)|couldn[’']t load/i.test(a?.text ?? ''))
        .map(([key, a]) => ({ key, title: 'An app that passed its check shows only a missing-data message', evidence: `“${clip(a.text, 160)}”` })),
  },
  {
    id: 'unreadable-app-marks',
    issue: 53,
    run: (f) =>
      Object.entries(f.apps ?? {})
        .filter(
          ([, a]) => a && ((a.tinyMarks >= 50 && a.tinyMarks / Math.max(1, a.marks) > 0.3) || (a.tinyText >= 5 && a.tinyText / Math.max(1, a.svgText) > 0.3)),
        )
        .map(([key, a]) => ({
          key,
          title: 'An app draws marks or text too small to read, and passed its check',
          evidence: `${a.tinyMarks} of ${a.marks} SVG marks under 4 px; ${a.tinyText} of ${a.svgText} SVG labels under 9 px.`,
        })),
  },
  {
    id: 'mixed-font-stacks',
    issue: 44,
    run: (f) =>
      Object.entries(f.apps ?? {})
        .filter(([, a]) => (a?.fonts ?? []).filter((x) => !/mono/i.test(x)).length > 1)
        .map(([key, a]) => ({
          key,
          title: 'An app mixes font stacks, so its text renders in different families where the stacks resolve differently (Firefox)',
          evidence: a.fonts.filter((x) => !/mono/i.test(x)).join(' | '),
        })),
  },
  {
    id: 'status-colors-for-categories',
    issue: 52,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId))
        .filter((app) => {
          const code = app.versions?.[app.current - 1]?.code ?? '';
          return /var\(--(?:good|alert|warn)\)/.test(code) && !/--s[1-8]\b/.test(code);
        })
        .map((app) => ({
          key: app.id,
          title: 'An app colors categories with status colors',
          evidence: `“${app.title}” uses --good/--alert and none of --s1…--s8.`,
        })),
  },
  {
    // Since #49’s fix, a new version brings the app to the newest point (item.move sets movedAt), and every later
    // message pushes it up again: no finding (#213). An app its last version didn’t move, with anything from before
    // that version under it, is the defect. A version with no time counts every item after the app, as before.
    id: 'updated-app-far-up',
    issue: 49,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId) && app.versions?.length > 1)
        .flatMap((app) => {
          const list = f.state.items[app.threadId] ?? [];
          const at = list.findIndex((it) => it.id === app.itemId);
          const landed = app.versions.at(-1)?.at;
          const timed = Number.isFinite(landed);
          if (at < 0 || (timed && Number.isFinite(list[at].movedAt) && list[at].movedAt >= landed - SLACK_MS)) return [];
          const up = list.slice(at + 1).filter((it) => !timed || !(it.at > landed)).length;
          if (up < (timed ? 1 : 6)) return [];
          return [
            {
              key: app.id,
              title: 'An updated app stays where it was first shown, far above the conversation',
              evidence: `“${app.title}” is v${app.versions.length}, ${up} message${up === 1 ? '' : 's'} up when that version landed, and that version didn’t move it.`,
            },
          ];
        }),
  },
  {
    id: 'version-menu-overflow',
    issue: 36,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId) && app.versions?.length >= 15)
        .map((app) => ({
          key: app.id,
          title: 'An app has enough versions to overflow its version menu',
          evidence: `“${app.title}” has ${app.versions.length} versions.`,
        })),
  },
  {
    id: 'check-starved',
    issue: 37,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId) && (app.check?.problems ?? []).some((p) => p.code === 'no-answer'))
        .map((app) => ({
          key: app.id,
          title: 'An app’s check timed out and is stored as “shown with problems”',
          evidence: `“${app.title}”: ${clip(app.check.problems[0].message)}`,
        })),
  },
  {
    id: 'full-screen-noop',
    issue: 45,
    run: (f) =>
      (f.probes?.fullScreen ?? [])
        // Full screen fills the window; a frame that only grows taller in the column isn’t that.
        .filter((p) => p.before && p.after && (p.after.w < p.viewport.w * 0.9 || p.after.h < p.viewport.h * 0.8))
        .map((p) => ({
          key: p.key,
          title: 'An app’s Expand button doesn’t show it full screen',
          evidence: `The frame went from ${p.before.w}×${p.before.h} to ${p.after.w}×${p.after.h} in a ${p.viewport.w}×${p.viewport.h} window.`,
        })),
  },
  {
    id: 'image-not-shown',
    issue: 48,
    run: (f) =>
      (f.probes?.attachments ?? [])
        .filter((a) => a.attachments > 0 && a.images === 0)
        .map((a) => ({
          key: a.key,
          title: 'An attached image shows as a file chip, not the image',
          evidence: `${a.attachments} attachment, 0 images rendered.`,
        })),
  },
  {
    id: 'review-table-raw',
    issue: 62,
    run: (f) =>
      itemsOf(f)
        .filter(
          (it) =>
            it.kind === 'block' &&
            it.valid &&
            it.block.type === 'review' &&
            it.block.format === 'markdown' &&
            /^\s*\|.*\|\s*\n\s*\|\s*:?-{3,}/m.test(it.block.content ?? '') &&
            // What’s on screen decides: since #62, a table renders as a table. Without a reading, assume it did.
            (f.ui?.reviewRawRows?.[it.id] ?? 0) > 0,
        )
        .map((it) => ({
          key: it.id,
          title: 'A review block’s Markdown table shows as raw pipes',
          evidence: `“${it.block.title ?? 'review'}” has a table, and ${f.ui.reviewRawRows[it.id]} of its rows show as raw pipes on screen.`,
        })),
  },
  {
    id: 'stale-progress',
    issue: 58,
    run: (f) =>
      itemsOf(f)
        .filter((it) => it.kind === 'block' && it.valid && it.block.type === 'progress' && (it.block.steps ?? []).some((s) => s.state === 'running'))
        .filter((it) => {
          const se = f.state.sessions[it.sessionId];
          return se && !['think', 'gen', 'tool'].includes(se.state);
        })
        .map((it) => ({
          key: it.id,
          title: 'A progress block still says “running” after its agent stopped',
          evidence: `“${it.block.title ?? 'progress'}”: ${(it.block.steps ?? [])
            .filter((s) => s.state === 'running')
            .map((s) => s.label)
            .join(', ')}.`,
        })),
  },
  {
    id: 'silent-while-working',
    issue: 68,
    run: (f) => {
      const silent = (f.samples ?? []).filter((s) => s.busy.length && s.rows === 0).length;
      const busy = (f.samples ?? []).filter((s) => s.busy.length).length;
      return busy >= 4 && silent / busy > 0.8
        ? [
            {
              title: 'While agents think or call tools, nothing on screen says what they’re doing',
              evidence: `In ${silent} of ${busy} samples taken while an agent worked, there was no working row or glimpse.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'model-not-shown',
    issue: 60,
    run: (f) =>
      // Claude’s families, or any model a persona in the run names: a Kiro persona can run gpt-5.6-terra (#117).
      f.ui?.headerText &&
      !/opus|sonnet|haiku|fable/i.test(f.ui.headerText) &&
      !Object.values(f.state?.personas ?? {}).some((p) => p.model && p.model !== 'mock' && f.ui.headerText.includes(p.model))
        ? [{ title: 'The UI doesn’t show which model an agent runs', evidence: `Agents section: “${clip(f.ui.headerText, 120)}”.` }]
        : [],
  },
  {
    // An Isolated Kiro persona runs with Postbox’s own Kiro home, so none of the person’s steering may load (#57).
    id: 'kiro-settings-leak',
    issue: 57,
    run: (f) => {
      const hits = kiroTurns(f).flatMap(({ handle, persona, events }) =>
        isolated(persona)
          ? events
              .map((e) => e?.data?.update?._meta?.kiro)
              .filter((k) => k?.kind === 'steering_inclusion' && Array.isArray(k.steeringDocuments) && k.steeringDocuments.length)
              .map((k) => ({ handle, n: k.steeringDocuments.length }))
          : [],
      );
      return hits.length
        ? [
            {
              title: 'An Isolated Kiro agent loaded the person’s steering files',
              evidence: hits
                .slice(0, 3)
                .map(({ handle, n }) => `@${handle} loaded ${n} steering file${n === 1 ? '' : 's'}`)
                .join('; ')
                .concat('.'),
            },
          ]
        : [];
    },
  },
  {
    // An Isolated Kiro persona denies every MCP server but Postbox’s, a server a managed install adds by itself
    // included (#57): a call to one that completed got through.
    id: 'kiro-mcp-leak',
    issue: 57,
    run: (f) => {
      const hits = kiroTurns(f).flatMap(({ handle, persona, calls }) =>
        isolated(persona) ? calls.filter((c) => c.completed && c.server && c.server !== POSTBOX_SERVER).map((c) => ({ handle, c })) : [],
      );
      return hits.length
        ? [
            {
              title: 'An Isolated Kiro agent used an MCP server other than Postbox’s',
              evidence: `${hits
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)} (${c.server})`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  {
    // Kiro can’t ask from Postbox, and a refusal leaves the turn “successful”, so the step is its only record (#65):
    // each refused call should be a denied step, under its toolCallId, in the conversation.
    id: 'kiro-refusal-not-shown',
    issue: 65,
    run: (f) => {
      const denied = new Set(
        Object.values(f.state.items ?? {})
          .flat()
          .flatMap((it) => it?.activity?.steps ?? [])
          .filter((st) => st.state === 'denied')
          .map((st) => st.id),
      );
      const hidden = kiroTurns(f).flatMap(({ handle, calls }) => calls.filter((c) => c.refused && !denied.has(c.id)).map((c) => ({ handle, c })));
      return hidden.length
        ? [
            {
              title: 'Kiro refused calls, and the conversation shows no refused step',
              evidence: `${hidden.length} refused without a step: ${hidden
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title || c.kind || c.id, 80)}`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  {
    // A Kiro call of a kind the persona’s Tools don’t tick, that ran (#5): the agent file’s deny rules didn’t hold.
    id: 'kiro-tool-not-allowed',
    issue: 5,
    run: (f) => {
      const hits = kiroTurns(f).flatMap(({ handle, persona, calls }) => {
        const has = new Set(persona.tools ?? []);
        return calls.filter((c) => c.completed && KIRO_KIND_TOOL[c.kind] && !has.has(KIRO_KIND_TOOL[c.kind])).map((c) => ({ handle, c }));
      });
      return hits.length
        ? [
            {
              title: 'Kiro agents ran tools their persona doesn’t allow',
              evidence: `${hits
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)} (${KIRO_KIND_TOOL[c.kind]})`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  {
    // Antigravity can’t ask from Postbox, and a refusal ends the turn with no reply, so the step is its only record
    // (#65): each refused call should be a denied step, under its id, in the conversation.
    id: 'agy-refusal-not-shown',
    issue: 65,
    run: (f) => {
      const denied = deniedSteps(f);
      const hidden = agyTurns(f).flatMap(({ handle, calls }) => calls.filter((c) => c.refused && !denied.has(c.id)).map((c) => ({ handle, c })));
      return hidden.length
        ? [
            {
              title: 'Antigravity refused calls, and the conversation shows no refused step',
              evidence: `${hidden.length} refused without a step: ${hidden
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)}`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  {
    // Postbox’s own tools need the allow rule the adapter adds to the person’s agy settings (#143). Refused, the
    // agent can’t show anything in the room.
    id: 'agy-postbox-refused',
    issue: 143,
    run: (f) => {
      const hits = agyTurns(f).flatMap(({ handle, calls }) => calls.filter((c) => c.refused && c.server === AGY_SERVER).map((c) => ({ handle, c })));
      return hits.length
        ? [
            {
              title: 'Antigravity refused Postbox’s own tools',
              evidence: `${hits
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)}`)
                .join('; ')}. The allow rule for ${AGY_SERVER} is missing from the agy settings.`,
            },
          ]
        : [];
    },
  },
  {
    // agy can’t turn a tool off for one agent, so the agent is told not to use the ones its persona doesn’t tick
    // (#5). One that ran anyway is the agent ignoring that.
    id: 'agy-tool-not-allowed',
    issue: 5,
    run: (f) => {
      const hits = agyTurns(f).flatMap(({ handle, persona, calls }) => {
        const has = new Set(persona.tools ?? []);
        return calls.filter((c) => c.completed && AGY_TOOL[c.name] && !has.has(AGY_TOOL[c.name])).map((c) => ({ handle, c }));
      });
      return hits.length
        ? [
            {
              title: 'Antigravity agents used tools their persona turned off',
              evidence: `${hits
                .slice(0, 3)
                .map(({ handle, c }) => `@${handle}: ${clip(c.title, 80)} (${AGY_TOOL[c.name]})`)
                .join('; ')}. Antigravity can’t turn them off; the agent was told not to use them.`,
            },
          ]
        : [];
    },
  },
  {
    // Two processes in one Claude Code session (#126): a turn that started while the session’s previous turn was still
    // making requests, or a stopped turn whose process went on calling Postbox’s tools after Stop. Claude Code turns
    // only; the Kiro CLI adapter stops a turn the same way, and isn’t judged here.
    id: 'two-processes-one-session',
    issue: 126,
    run: (f) => {
      const out = [];
      /** @type {Map<string, { s: any, start: number|null, last: number|null }[]>} */
      const byClaude = new Map();
      for (const s of f.streams ?? []) {
        const id = claudeSessionOf(s.events);
        if (!id) continue;
        byClaude.set(id, [...(byClaude.get(id) ?? []), { s, ...streamSpan(s) }]);
      }
      for (const [id, list] of byClaude) {
        const timed = list.filter((x) => x.start !== null).sort((a, b) => /** @type {number} */ (a.start) - /** @type {number} */ (b.start));
        for (let i = 1; i < timed.length; i++) {
          const b = timed[i];
          const a = timed.slice(0, i).find((x) => x.last !== null && /** @type {number} */ (x.last) > /** @type {number} */ (b.start) + SLACK_MS);
          if (!a) continue;
          const start = /** @type {number} */ (b.start);
          const last = /** @type {number} */ (a.last);
          out.push({
            key: `overlap:${id}:${start}`,
            title: 'Two turns of one agent session ran at the same time',
            evidence: `@${b.s.handle}’s turn started at ${clock(start)} while the session’s previous turn (Claude Code session ${id.slice(0, 8)}) went on until ${clock(last)}, ${secs(last - start)} later.`,
          });
        }
      }
      // A stopped turn’s Postbox calls after Stop. The stopped item names the session; the session names its Claude
      // Code session, and so the streams that are its turns.
      for (const it of itemsOf(f)) {
        if (it.kind !== 'agent' || it.status !== 'stopped' || !Number.isFinite(it.stoppedAt)) continue;
        const claudeId = f.state.sessions?.[it.sessionId]?.backendState?.claudeSessionId;
        if (!claudeId) continue;
        for (const s of f.streams ?? []) {
          const span = streamSpan(s);
          if (claudeSessionOf(s.events) !== claudeId || span.start === null || span.start > it.stoppedAt) continue;
          const calls = postboxCallsAfter(s.events, it.stoppedAt + SLACK_MS);
          if (!calls.length) continue;
          const names = [...new Set(calls.map((c) => c.name))];
          out.push({
            key: `after-stop:${it.id}`,
            title: 'A stopped turn went on calling Postbox’s tools',
            evidence: `@${it.handle} was stopped at ${clock(it.stoppedAt)}, and its process then made ${calls.length} Postbox call${calls.length === 1 ? '' : 's'} (${names.slice(0, 4).join(', ')}), the last ${secs(Math.max(...calls.map((c) => c.at)) - it.stoppedAt)} after Stop.`,
          });
          break;
        }
      }
      return out;
    },
  },
  {
    // A background command whose step says done while it runs (#126, which takes this part of #129). Running is read
    // from the stream: it started in the background and the stream hasn’t reported its end. A fix’s own job record,
    // when there is one, says whether it ended.
    id: 'background-step-closed',
    issue: 126,
    run: (f) => {
      /** @type {Map<string, { step: any, it: any }>} */
      const steps = new Map();
      for (const it of itemsOf(f)) for (const st of it.activity?.steps ?? []) if (st?.id) steps.set(st.id, { step: st, it });
      return (f.streams ?? []).flatMap(({ handle, events }) =>
        backgroundJobs(events).flatMap((j) => {
          const shown = steps.get(j.id);
          if (shown?.step.state !== 'done') return [];
          const record = jobRecord(f.state, j);
          // A fix keeps the job’s record while it runs, and its step running until it ends: a step it closed (one that
          // names its job) with no record left has ended, whatever the stream, whose CLI Keep running ends, says.
          if (record ? record.ended : j.ended || shown.step.job) return [];
          return [
            {
              key: j.id,
              title: 'A background command’s step reads done while the command still runs',
              evidence: `@${handle}’s step “${clip(shown.step.label, 100)}” says done, but ${record ? 'Postbox’s record of the job' : 'the stream'} hasn’t seen it end${j.task ? ` (background id ${j.task})` : ''}: ${clip(j.command, 120) || 'a background command'}.`,
            },
          ];
        }),
      );
    },
  },
  {
    // One session showing two blocks with one id in a conversation (#125): an answer, an update and an outcome all
    // name a block by id, so they can’t tell the two apart. A block that failed to validate isn’t shown as one.
    id: 'duplicate-block-id',
    issue: 125,
    run: (f) => {
      /** @type {Map<string, any[]>} */
      const groups = new Map();
      for (const it of itemsOf(f)) {
        if (it.kind !== 'block' || !it.valid || !it.block?.id) continue;
        const k = `${it.threadId}\n${it.sessionId}\n${it.block.id}`;
        groups.set(k, [...(groups.get(k) ?? []), it]);
      }
      return [...groups.values()]
        .filter((list) => list.length > 1)
        .map((list) => {
          const times = list.map((it) => it.at).filter((n) => Number.isFinite(n));
          return {
            key: `${list[0].threadId}:${list[0].sessionId}:${list[0].block.id}`,
            title: 'An agent showed two blocks with the same id in one conversation',
            evidence: `@${list[0].handle} showed “${clip(list[0].block.id, 80)}” ${list.length} times in “${f.state.threads?.[list[0].threadId]?.title ?? list[0].threadId}”: ${list
              .map((it) => `${it.id} (“${clip(it.block.title ?? it.block.prompt ?? it.block.type, 60)}”)`)
              .join(', ')}${times.length > 1 ? `, ${secs(Math.max(...times) - Math.min(...times))} apart` : ''}.`,
          };
        });
    },
  },
  {
    // An answer and the revision it was for (#123). Two ways it goes wrong, read from the history: an answer applied to
    // a revision other than the one the person was answering (what the runner read just before it answered, or the
    // revision a fix records on the answer), and an update that reopened an answered block before the agent read the
    // answer, which erases it unread.
    id: 'approval-for-other-revision',
    issue: 123,
    run: (f) => {
      const out = [];
      const { answers, reopened } = blockHistory(f.events ?? []);
      for (const r of reopened)
        out.push({
          key: `reopened:${r.itemId}:${r.revision}`,
          title: 'An agent’s update reopened a block the person had answered, before the agent read the answer',
          evidence: `@${r.handle}’s update made revision ${r.revision} of “${clip(r.title, 80)}”${r.ms !== null ? ` ${secs(r.ms)}` : ''} after the person’s ${r.answer.action} on revision ${r.answer.revision}, with no turn in between to read it, so the answer was erased unread.`,
        });
      const probes = f.probes?.answers ?? [];
      for (const a of answers) {
        // The runner’s note for this answer: its latest one on the block before the answer landed.
        const probe = Number.isFinite(a.at)
          ? probes.filter((p) => p.key === a.itemId && Number.isFinite(p.at) && p.at <= a.at + SLACK_MS).sort((x, y) => y.at - x.at)[0]
          : undefined;
        const saw = a.saw ?? probe?.revision ?? null;
        if (saw === null || saw === a.revision) continue;
        out.push({
          key: `answer:${a.itemId}:${a.seq}`,
          title: 'An answer was applied to a revision the person didn’t answer',
          evidence: `The person answered revision ${saw} of @${a.handle}’s “${clip(a.title, 80)}”, and Postbox applied their ${a.action} to revision ${a.revision}.`,
        });
      }
      return out;
    },
  },
  {
    // An allowed wake that delivered less than the agent sent (#108): the request kept a 200-character preview, and
    // allowing it delivered the preview. The delivered message is the sender’s item in the side thread; what it sent
    // is the request’s full text (a fix keeps it), or else its wake_agent call or reply.
    id: 'wake-text-clipped',
    issue: 108,
    run: (f) => {
      const items = itemsOf(f);
      const sent = wakesSent(f);
      return items
        .filter((it) => it.kind === 'hop' && it.status === 'allowed' && typeof it.reason === 'string')
        .flatMap((hop) => {
          const full = typeof hop.text === 'string' ? hop.text : null;
          const side = items.filter(
            (x) =>
              x.kind === 'agent' &&
              !x.turnId &&
              x.sessionId === hop.fromSessionId &&
              (x.at ?? 0) >= (hop.at ?? 0) &&
              f.state.threads?.[x.threadId]?.kind === 'side',
          );
          const delivered = (full !== null ? side.find((x) => x.text === full) : null) ?? side.find((x) => x.text === hop.reason);
          if (!delivered) return [];
          const original =
            full ??
            sent.find(
              (m) => m.from === hop.from && (m.to === null || m.to === hop.to) && m.text.length > delivered.text.length && clip200(m.text) === hop.reason,
            )?.text ??
            null;
          // Clipped, not only made plain: a message of 200 characters or fewer was never cut.
          const short =
            original !== null ? original.length > 200 && delivered.text.length < original.length : /…$/.test(hop.reason) && hop.reason.length >= 200;
          if (!short) return [];
          return [
            {
              key: hop.id,
              title: 'An allowed agent wake delivered less than the agent sent',
              evidence:
                original !== null
                  ? `@${hop.from} sent @${hop.to} ${original.length.toLocaleString('en-US')} characters; once the wake was allowed, @${hop.to} got ${delivered.text.length.toLocaleString('en-US')}, ending “${clip(delivered.text.slice(-60), 60)}”.`
                  : `Once the wake was allowed, @${hop.to} got only the request’s ${delivered.text.length}-character preview, ending “${clip(delivered.text.slice(-60), 60)}”.`,
            },
          ];
        });
    },
  },
  {
    id: 'page-errors',
    issue: null,
    run: (f) => {
      const errs = (f.console ?? []).filter((l) => !/Diagram: |Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(l));
      return errs.length
        ? [
            {
              title: 'The page logged errors',
              evidence: errs
                .slice(0, 3)
                .map((l) => clip(l, 160))
                .join(' | '),
            },
          ]
        : [];
    },
  },
  {
    id: 'agents-section-members',
    issue: 105,
    run: (f) => {
      if (!Array.isArray(f.ui?.agentRows) || !f.threads.length) return [];
      const main = f.state.threads[f.threads[0]];
      const members = (main?.members ?? [])
        .map((id) => f.state.sessions[id])
        .filter((se) => se && !se.archived)
        .map((se) => se.handle);
      const missing = members.filter((h) => !f.ui.agentRows.includes(h));
      return missing.length
        ? [
            {
              title: 'An agent in the conversation has no row in the Agents section',
              evidence: `Missing: @${missing.join(', @')}. Rows: ${f.ui.agentRows.map((h) => `@${h}`).join(', ') || 'none'}.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'topbar-title-cut',
    issue: 105,
    run: (f) =>
      f.ui?.topbarCut
        ? [
            {
              title: 'The top bar cuts the conversation’s title or project at a wide window',
              evidence: 'A title or crumb in the top bar is narrower than its text at 1200 px or wider.',
            },
          ]
        : [],
  },
  {
    id: 'work-files-match-stream',
    issue: 132,
    run: (f) => {
      const ledger = new Set(
        ledgerEntries(f)
          .filter((e) => e.kind === 'file')
          .map((e) => e.path),
      );
      const edited = new Set(
        (f.streams ?? []).flatMap((s) =>
          toolCalls(s.events)
            .filter((c) => EDIT_TOOLS.has(c.name) && !c.denied && c.result && !c.result.is_error)
            .map((c) => c.input.file_path ?? c.input.notebook_path),
        ),
      );
      const missing = [...edited].filter((p) => p && !ledger.has(p));
      return missing.length
        ? [
            {
              title: 'A file an agent changed isn’t in the Work view',
              evidence: `Changed by an Edit or Write call, but not in the ledger: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'work-commands-match-stream',
    issue: 132,
    run: (f) => {
      const ledger = new Set(
        ledgerEntries(f)
          .filter((e) => e.kind === 'command')
          .map((e) => e.toolUseId),
      );
      const ran = (f.streams ?? []).flatMap((s) =>
        toolCalls(s.events)
          .filter((c) => c.name === 'Bash')
          .map((c) => ({ ...c, handle: s.handle })),
      );
      const missing = ran.filter((c) => !ledger.has(c.id));
      return missing.length
        ? [
            {
              title: 'A command an agent ran isn’t in the Work view',
              evidence: `${missing.length} of ${ran.length} Bash calls aren’t in the ledger, such as @${missing[0].handle}’s \`${String(missing[0].input.command ?? '').slice(0, 80)}\`.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'quick-panel-takes-effect',
    issue: 105,
    run: (f) =>
      (f.probes?.panels ?? []).flatMap((p) => {
        if (!p.set?.model) return [];
        const next = (f.streams ?? []).filter((s) => s.handle === p.handle && (s.started ?? 0) > p.at).sort((a, b) => (a.started ?? 0) - (b.started ?? 0))[0];
        const model = next?.events.find((e) => e.type === 'system' && e.subtype === 'init')?.model;
        if (!model || modelKey(model).includes(modelKey(p.set.model))) return [];
        return [
          {
            title: 'A model picked in the quick panel didn’t reach the agent’s next turn',
            evidence: `Picked “${p.set.model}” for @${p.handle}; its next turn ran ${model}.`,
          },
        ];
      }),
  },
  {
    id: 'shell-off-silent',
    issue: 104,
    run: (f) =>
      (f.probes?.panels ?? []).flatMap((p) => {
        if (p.set?.shell !== false) return [];
        const after = (f.streams ?? []).filter((s) => s.handle === p.handle && (s.started ?? 0) > p.at);
        const refused = after.flatMap((s) => toolCalls(s.events).filter((c) => c.name === 'Bash' && (c.denied || c.result?.is_error)));
        if (!refused.length) return [];
        const shown = itemsOf(f).some((it) => it.kind === 'denial' && it.handle === p.handle && it.at > p.at);
        return shown
          ? []
          : [
              {
                title: 'A command refused because Shell is off didn’t show as refused',
                evidence: `@${p.handle} tried ${refused.length} command(s) after Shell was turned off, and no refused step or card shows.`,
              },
            ];
      }),
  },
  {
    id: 'pane-split',
    issue: 146,
    run: (f) =>
      (f.probes?.panes ?? [])
        .filter((p) => p.work && p.thread && Math.min(p.work.h, p.thread.h) < 120)
        .map((p) => ({
          title: 'With a thread and Work open, one of them is too short to use',
          evidence: `Work ${p.work.w}×${p.work.h}, thread ${p.thread.w}×${p.thread.h}.`,
        })),
  },
  {
    id: 'fullscreen-keeps-draft',
    issue: 146,
    run: (f) =>
      (f.probes?.drafts ?? [])
        .filter((d) => {
          // A thread at its end stays at its end; anywhere else, it stays where it was.
          const at = (x) => (typeof x === 'object' && x ? x : { top: x ?? 0, gap: Number.POSITIVE_INFINITY });
          const [b, a] = [at(d.before), at(d.after)];
          const moved = b.gap <= 2 ? a.gap > 2 : Math.abs(a.top - b.top) > 2;
          return !d.kept || !d.exited || moved;
        })
        .map((d) => ({
          title: 'A thread lost its place going full screen and back',
          evidence: `${d.kept ? 'The draft was kept' : `The draft became ${JSON.stringify(d.draft)}`}; ${d.exited ? 'full screen closed' : 'full screen didn’t close'}; scrolled ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}.`,
        })),
  },
];

/**
 * Runs every check, or only those named; each finding carries its check id and issue number.
 * @param {any} facts  @param {{ only?: string[] | null }} [opts]
 */
export function runChecks(facts, { only = null } = {}) {
  return CHECKS.filter((c) => !only || only.includes(c.id)).flatMap((c) => {
    try {
      // A finding can set its own issue (null for information), and carry a verdict, a note and counts for the
      // report: the block counts for M1’s exit check do.
      return c.run(facts).map((x) => ({
        check: c.id,
        issue: x.issue === undefined ? c.issue : x.issue,
        key: x.key ?? c.id,
        title: x.title,
        evidence: x.evidence,
        ...(x.verdict ? { verdict: x.verdict, note: x.note } : {}),
        ...(x.counts ? { counts: x.counts } : {}),
      }));
    } catch (e) {
      return [{ check: c.id, issue: null, key: `${c.id}-error`, title: `The ${c.id} check failed`, evidence: e.message }];
    }
  });
}
