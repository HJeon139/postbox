// Scheduled wake lifecycle: persistence, timers, cancellation, restart re-arming and network recovery (#458, #466).

import { cutText } from '../shared/text-parts.mjs';
import { isNetworkFailure } from './harness-failure.mjs';
import { httpError } from './helpers.mjs';
import { hostOf } from './remote/placement.mjs';
import { ON_HOST } from './remote/turns-shared.mjs';
import { newId } from './store.mjs';
import { whenWritable } from './store-wait.mjs';
import { READ_TOOLS } from './tool-gate.mjs';

const DAY = 24 * 3600 * 1000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_WINDOW_MS = 60 * 60_000;
const TOOL_LIMIT = 20;
const TOOL_NAME_CHARS = 100;
/** Postbox’s MCP server, as Claude Code names its tools (mcp__postbox__show_block) and agy-tools.mjs names Antigravity’s. */
const POSTBOX_MCP = /^mcp__postbox__/;

/** Creates and arms one scheduled wake. @param {any} rt @param {string} sessionId @param {{ inMs: number, note?: string }} options */
export function scheduleWake(rt, sessionId, { inMs, note }) {
  const se = rt.session(sessionId);
  const at = Date.now() + Math.max(1000, Math.min(inMs, 7 * DAY));
  const sc = { id: newId('sc'), sessionId, threadId: se.threadId, handle: se.handle, at, note: cutText(String(note ?? ''), 200) };
  rt.store.emit('schedule', sc);
  const line = { kind: 'system', variant: 'schedule', scheduleId: sc.id, handle: se.handle, at, note: sc.note, status: 'pending' };
  const it = rt.threads.addItem(se.threadId, line);
  sc.itemId = it.id;
  rt.store.emit('schedule', sc);
  armWake(rt, sc);
  return sc;
}

/**
 * Arms one current, pending schedule. Each read of a schedule here decides a write, so it reads one just scheduled or
 * changed behind a held commit too (#623): read from the published state, a wake scheduled then was never armed.
 * @param {any} rt @param {any} sc
 */
export function armWake(rt, sc) {
  const current = rt.store.pending.schedule(sc.id);
  if (!current || current.running) return;
  clearTimeout(rt.timers.get(sc.id));
  rt.timers.set(sc.id, setTimeout(() => fireScheduledWake(rt, sc.id), Math.max(0, current.at - Date.now())).unref());
}

/** Fires one due wake. Exported so deterministic tests don’t wait for real time. @param {any} rt @param {string|any} schedule */
export function fireScheduledWake(rt, schedule) {
  const id = typeof schedule === 'string' ? schedule : schedule?.id;
  const sc = rt.store.pending.schedule(id);
  rt.timers.delete(id);
  if (!sc || sc.running) return;
  // While writes are closed the whole fire waits, owned by its schedule: nothing goes into memory only, no start is
  // held, and if Retry reinstalls the state the re-arm is its one owner (S1).
  if (!rt.store.writable) return whenWritable(rt, () => fireScheduledWake(rt, id), { owner: id });
  const running = { ...sc, running: true };
  rt.store.emit('schedule', running);
  if (sc.itemId) rt.threads.patchItem(sc.threadId, sc.itemId, { status: 'running' });
  // A retired fork isn’t woken: deliver() would refuse it, here outside any request (#228).
  const se = rt.store.pending.session(sc.sessionId);
  if (!se || se.retiredFork) return finishSchedule(rt, running, 'canceled');
  if (!sc.attempt) rt.threads.addItem(sc.threadId, { kind: 'system', variant: 'wake', from: sc.handle, to: sc.handle, scheduled: true });
  const message = { kind: 'wake', note: sc.recoveryNote ?? sc.note, scheduledWakeId: sc.id };
  // A scheduled entry (designs/rooms-at-scale.md, “What an entry is”) that carries the wake its turn keeps (#466).
  rt.delivery.send({ sessionId: sc.sessionId, threadId: sc.threadId, source: 'scheduled', text: String(message.note ?? ''), message });
}

/**
 * A manual Retry takes ownership from the armed timer and uses the schedule’s current recovery note. One whose schedule
 * you canceled or that finished still sends the recovery its line kept, not the instruction a tool already acted on.
 * @param {any} rt @param {any} message @param {string} threadId  where the schedule’s line is
 */
export function prepareScheduledRetry(rt, message, threadId) {
  if (message?.retry !== true || typeof message.scheduledWakeId !== 'string') return message;
  const sc = rt.store.pending.schedule(message.scheduledWakeId);
  if (!sc) {
    // As written: a cancel and the line’s recovery note may both be held behind a commit (#623).
    const line = rt.store.pending.items(threadId).find((i) => i.kind === 'system' && i.scheduleId === message.scheduledWakeId);
    return line?.recoveryNote ? { ...message, note: line.recoveryNote } : message;
  }
  clearTimeout(rt.timers.get(sc.id));
  rt.timers.delete(sc.id);
  rt.store.emit('schedule', { ...sc, running: true });
  if (sc.itemId) rt.threads.patchItem(sc.threadId, sc.itemId, { status: 'running' });
  return { ...message, note: sc.recoveryNote ?? sc.note };
}

/**
 * A tool start for the recovery, once per call: Claude Code reports one through both toolUse and activity, by its id,
 * and a Postbox tool through MCP too, under its bare name. Saved on the schedule as it starts, so a restart in the middle
 * of the turn still knows (rearmWakes).
 */
const addTool = (rt, turn, name, id) => {
  const scheduleId = turn.asked?.message?.scheduledWakeId;
  if (!scheduleId || typeof name !== 'string') return;
  turn.scheduledToolIds ??= new Set();
  if (id != null && turn.scheduledToolIds.has(id)) return;
  if (id != null) turn.scheduledToolIds.add(id);
  // Only Postbox’s own server name goes: another server’s tool keeps it, so the agent can tell which one ran.
  const clipped = name.replace(POSTBOX_MCP, '').slice(0, TOOL_NAME_CHARS);
  turn.scheduledTools ??= [];
  if (turn.scheduledTools.includes(clipped) || turn.scheduledTools.length >= TOOL_LIMIT) return;
  turn.scheduledTools.push(clipped);
  const sc = rt.store.pending.schedule(scheduleId);
  // Kept with the tools an earlier turn of the same wake started, for a turn attached again after a restart (#466).
  if (sc) rt.store.emit('schedule', { ...sc, startedTools: [...new Set([...(sc.startedTools ?? []), ...turn.scheduledTools])].slice(0, TOOL_LIMIT) });
};

/** Records a tool start, by toolUse or by activity, including what scheduled-wake recovery will need. */
export function recordScheduledTool(rt, turn, call, ledger = true) {
  if (ledger) rt.ledger.toolUse(turn, call);
  addTool(rt, turn, call?.name, call?.id);
}

/** Postbox’s tools that only read, which can’t have changed anything a recovery must check (tool-gate.mjs). */
const READS = READ_TOOLS;

/**
 * A turn’s Postbox tools (toolsFor), each recorded as it starts for a scheduled wake’s recovery (#466). Every backend calls
 * them, through MCP, from a host or in the turn, and some, as Kiro does for its quiet ones, report no tool start of
 * their own. @param {any} rt @param {any} turn @param {Record<string, Function>} tools
 */
export function recordedTools(rt, turn, tools) {
  if (!turn) return tools;
  // Called on the tools as they were: show_app calls this.show_block or this.update_app, which is still one call.
  const raw = { ...tools };
  for (const [name, fn] of Object.entries(raw))
    if (!READS.has(name))
      tools[name] = (...args) => {
        addTool(rt, turn, name, null);
        return fn.apply(raw, args);
      };
  return tools;
}

/** The bounded delay before retry number attempt. */
const retryDelay = (attempt) => Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(Math.max(0, attempt - 1), 9));
const recoveryText = (turn, tools, why = 'failed because the network dropped') =>
  `[Postbox] Your last scheduled turn${turn ? ` (${turn.id})` : ''} ${why} after it started ${tools.join(', ')}. Check what those calls changed or sent before you continue. Do not repeat them until you have checked their effects.`;

/** Settles a scheduled wake’s turn, re-arming only the current schedule after a network failure. */
export function settleScheduledWake(rt, turn, err) {
  const id = turn.asked?.message?.scheduledWakeId;
  if (!id) return;
  const sc = rt.store.pending.schedule(id);
  if (!sc) return;
  if (!err || err.name === 'AbortError') return finishSchedule(rt, sc, err ? 'canceled' : 'done');
  // A host turn marked lost is still running there and RemoteTurns will attach it again: no second recovery is armed,
  // and the schedule stays running for the turn attached again, which carries the wake and settles it (#466).
  const r = rt.store.pending.session(turn.sessionId)?.remoteTurn;
  if (r?.state === 'lost') return;
  // Nor while the wake’s own host turn still waits to be attached, when the attach’s own start failed (#466).
  if (ON_HOST.has(r?.state) && typeof sc.turnId === 'string' && r.rtTurn === sc.turnId && sc.turnId !== turn.id) return;
  if (!isNetworkFailure(err)) return finishSchedule(rt, sc, 'done');
  // With the tools the wake’s earlier turn started too, as a turn attached again may not report them again (#466).
  retryWake(rt, sc, turn, [...(sc.startedTools ?? []), ...(turn.scheduledTools ?? [])]);
}

/**
 * A wake whose turn the network took: due again under the same id after the bounded backoff, as a recovery when a tool
 * had started, until the retry window runs out (#466). @param {any} rt @param {any} sc @param {any} turn  null when
 * the turn isn’t here to name @param {string[]} started  the tools its turn started @param {string} [why]
 */
function retryWake(rt, sc, turn, started, why) {
  const now = Date.now();
  const attempt = (sc.attempt ?? 0) + 1;
  const firstFailureAt = sc.firstFailureAt ?? now;
  if (now - firstFailureAt >= RETRY_WINDOW_MS) {
    finishSchedule(rt, sc, 'stopped', { retryAttempt: attempt, retryStopped: true });
    return;
  }
  const tools = [...new Set([...(sc.recoveryTools ?? []), ...started])].slice(0, TOOL_LIMIT);
  const next = {
    ...sc,
    running: false,
    turnId: undefined,
    at: now + retryDelay(attempt),
    attempt,
    firstFailureAt,
    ...(tools.length ? { recoveryTools: tools, recoveryNote: recoveryText(turn, tools, why) } : {}),
  };
  rt.store.emit('schedule', next);
  // The line keeps the recovery too, for a Retry after you cancel the schedule (prepareScheduledRetry).
  if (next.itemId)
    rt.threads.patchItem(next.threadId, next.itemId, {
      status: 'pending',
      at: next.at,
      retryAttempt: attempt,
      retryStopped: false,
      ...(next.recoveryNote ? { recoveryNote: next.recoveryNote } : {}),
    });
  armWake(rt, next);
}

function finishSchedule(rt, sc, status, patch = {}) {
  clearTimeout(rt.timers.get(sc.id));
  rt.timers.delete(sc.id);
  rt.store.emit('schedule', { id: sc.id, removed: true });
  if (sc.itemId) rt.threads.patchItem(sc.threadId, sc.itemId, { status, retryAttempt: null, retryStopped: false, ...patch });
}

/** Cancels one pending or running schedule. @param {any} rt @param {string} scheduleId */
export function cancelWakeSchedule(rt, scheduleId) {
  const sc = rt.store.pending.schedule(scheduleId);
  if (!sc) throw httpError(404, 'That wake-up already happened or was canceled.');
  // A fire waiting in the inbox goes with it, as one held behind a turn did; one a turn took is that turn’s.
  leftOver(rt, sc, ['waiting']);
  finishSchedule(rt, sc, 'canceled');
}

/**
 * The wake’s own turn, saved on its schedule as the turn goes to a host, so a restart can tell it from another turn
 * there (rearmWakes). @param {any} rt @param {any} turn
 */
export function noteScheduledTurn(rt, turn) {
  const id = turn?.asked?.message?.scheduledWakeId;
  const sc = typeof id === 'string' ? rt.store.pending.schedule(id) : null;
  if (sc && sc.turnId !== turn.id) rt.store.emit('schedule', { ...sc, turnId: turn.id });
}

/**
 * A wake whose own turn on a host Postbox gives up attaching again (#466). Its agent moved off that host, so the wake
 * is retried as one whose turn the network took, there where it runs now. Still placed on a host Postbox can’t reach
 * any more (removed, or no hosts at all), a retry could only fail there, so the wake stops, and its line says so.
 * @param {any} rt @param {string} sessionId
 */
export function retryHostWake(rt, sessionId) {
  const se = rt.store.pending.session(sessionId);
  const r = se?.remoteTurn;
  // Only a running wake names its turn: a retry, a re-arm and a finish each drop it.
  const own = (/** @type {any} */ sc) => sc.sessionId === sessionId && typeof sc.turnId === 'string' && sc.turnId === r?.rtTurn;
  const sc = Object.values(rt.store.pending.schedules()).find(own);
  if (!sc) return;
  if (hostOf(rt.personas.forSession(se)) === r.hostId) return finishSchedule(rt, sc, 'stopped');
  retryWake(rt, sc, null, sc.startedTools ?? [], 'was cut off from its host');
}

/** Whether a running schedule’s own turn is still on its host, in any state RemoteTurns attaches again. */
const onHost = (rt, sc) => {
  const r = rt.s.sessions[sc.sessionId]?.remoteTurn;
  return typeof sc.turnId === 'string' && ON_HOST.has(r?.state) && r.rtTurn === sc.turnId;
};

/**
 * Re-arms schedules after restart. One interrupted while running becomes due again, as a recovery if a tool had started,
 * so its instruction isn’t replayed. One whose own turn is still on a host is that turn’s: it stays running, unarmed,
 * and the turn RemoteTurns attaches again carries the wake and settles it, retried on a network failure as the first
 * turn would have been (#466). One queued behind another turn there never started its own, so it’s due again too.
 */
export function rearmWakes(rt) {
  for (const sc of Object.values(rt.s.schedules)) {
    // The schedule owns its wake across a restart: an entry its last fire left is stopped, and the wake fires again,
    // with the recovery when a tool had started, rather than the inbox resending the instruction (#466).
    leftOver(rt, sc);
    if (sc.running && onHost(rt, sc)) continue;
    const tools = [...new Set([...(sc.recoveryTools ?? []), ...(sc.startedTools ?? [])])].slice(0, TOOL_LIMIT);
    const interrupted = tools.length ? { recoveryTools: tools, recoveryNote: recoveryText(null, tools, 'was interrupted when Postbox stopped') } : {};
    const pending = sc.running ? { ...sc, running: false, at: Date.now(), startedTools: undefined, turnId: undefined, ...interrupted } : sc;
    if (pending !== sc) rt.store.emit('schedule', pending);
    armWake(rt, pending);
  }
}

/**
 * Stops a schedule’s entries in the given states: what an earlier fire left, at a restart, or a wake still waiting when
 * its schedule is canceled. @param {any} rt @param {any} sc @param {string[]} [states]
 */
function leftOver(rt, sc, states = ['waiting', 'taken']) {
  for (const e of rt.delivery.inbox(sc.sessionId))
    if (e.source === 'scheduled' && e.message?.scheduledWakeId === sc.id && states.includes(e.state)) rt.delivery.patch(e, { state: 'stopped' });
}

/**
 * The wakes still to come for a session being deleted go with it (#1670): left, each would name a session and maybe a
 * conversation that’s gone, with its timer running, until it fired and found nothing. @param {any} rt @param {string} sessionId
 */
export function dropSchedulesOf(rt, sessionId) {
  for (const sc of Object.values(rt.store.pending.schedules())) if (sc.sessionId === sessionId) finishSchedule(rt, sc, 'canceled');
}

/** A scheduled wake waiting behind a turn you stopped goes with it (#466): it’s settled, not left running. */
export function dropScheduledWake(rt, message) {
  const sc = typeof message?.scheduledWakeId === 'string' ? rt.store.pending.schedule(message.scheduledWakeId) : null;
  if (sc) finishSchedule(rt, sc, 'canceled');
}
