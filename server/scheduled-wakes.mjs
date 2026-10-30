// Scheduled wake lifecycle: persistence, timers, cancellation, restart re-arming and network recovery (#458, #466).

import { httpError } from './helpers.mjs';
import { ON_HOST } from './remote/turns-shared.mjs';
import { newId } from './store.mjs';
import { whenWritable } from './store-outage.mjs';

const DAY = 24 * 3600 * 1000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_WINDOW_MS = 60 * 60_000;
const NETWORK_CODES = new Set(['EADDRNOTAVAIL', 'ENOTFOUND', 'ECONNRESET']);
const TOOL_LIMIT = 20;
const TOOL_NAME_CHARS = 100;
/** Postbox’s MCP server, as Claude Code names its tools (mcp__postbox__show_block) and agy-tools.mjs names Antigravity’s. */
const POSTBOX_MCP = /^mcp__postbox__/;

/** Creates and arms one scheduled wake. @param {any} rt @param {string} sessionId @param {{ inMs: number, note?: string }} options */
export function scheduleWake(rt, sessionId, { inMs, note }) {
  const se = rt.session(sessionId);
  const at = Date.now() + Math.max(1000, Math.min(inMs, 7 * DAY));
  const sc = { id: newId('sc'), sessionId, threadId: se.threadId, handle: se.handle, at, note: String(note ?? '').slice(0, 200) };
  rt.store.emit('schedule', sc);
  const it = rt.addItem(se.threadId, { kind: 'system', variant: 'schedule', scheduleId: sc.id, handle: se.handle, at, note: sc.note, status: 'pending' });
  sc.itemId = it.id;
  rt.store.emit('schedule', sc);
  armWake(rt, sc);
  return sc;
}

/** Arms one current, pending schedule. One due while the store can’t be written fires once it can. @param {any} rt @param {any} sc */
export function armWake(rt, sc) {
  const current = rt.s.schedules[sc.id];
  if (!current || current.running) return;
  clearTimeout(rt.timers.get(sc.id));
  rt.timers.set(sc.id, setTimeout(() => whenWritable(rt, () => fireScheduledWake(rt, sc.id)), Math.max(0, current.at - Date.now())).unref());
}

/** Fires one due wake. Exported so deterministic tests don’t wait for real time. @param {any} rt @param {string|any} schedule */
export function fireScheduledWake(rt, schedule) {
  const id = typeof schedule === 'string' ? schedule : schedule?.id;
  const sc = rt.s.schedules[id];
  rt.timers.delete(id);
  if (!sc || sc.running) return;
  const running = { ...sc, running: true };
  rt.store.emit('schedule', running);
  if (sc.itemId) rt.patchItem(sc.threadId, sc.itemId, { status: 'running' });
  // An archived agent isn’t woken: deliver() would refuse it, here outside any request (#101).
  if (!rt.s.sessions[sc.sessionId] || rt.s.sessions[sc.sessionId].archived) return finishSchedule(rt, running, 'canceled');
  if (!sc.attempt) rt.addItem(sc.threadId, { kind: 'system', variant: 'wake', from: sc.handle, to: sc.handle, scheduled: true });
  rt.deliver(sc.sessionId, { kind: 'wake', note: sc.recoveryNote ?? sc.note, scheduledWakeId: sc.id });
}

/**
 * A manual Retry takes ownership from the armed timer and uses the schedule’s current recovery note. One whose schedule
 * you canceled or that finished still sends the recovery its line kept, not the instruction a tool already acted on.
 * @param {any} rt @param {any} message @param {string} threadId  where the schedule’s line is
 */
export function prepareScheduledRetry(rt, message, threadId) {
  if (message?.retry !== true || typeof message.scheduledWakeId !== 'string') return message;
  const sc = rt.s.schedules[message.scheduledWakeId];
  if (!sc) {
    const line = rt.store.items(threadId).find((i) => i.kind === 'system' && i.scheduleId === message.scheduledWakeId);
    return line?.recoveryNote ? { ...message, note: line.recoveryNote } : message;
  }
  clearTimeout(rt.timers.get(sc.id));
  rt.timers.delete(sc.id);
  rt.store.emit('schedule', { ...sc, running: true });
  if (sc.itemId) rt.patchItem(sc.threadId, sc.itemId, { status: 'running' });
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
  const sc = rt.s.schedules[scheduleId];
  if (sc) rt.store.emit('schedule', { ...sc, startedTools: [...turn.scheduledTools] });
};

/** Records a tool start, by toolUse or by activity, including what scheduled-wake recovery will need. */
export function recordScheduledTool(rt, turn, call, ledger = true) {
  if (ledger) rt.ledger.toolUse(turn, call);
  addTool(rt, turn, call?.name, call?.id);
}

/** Postbox’s tools that only read, which can’t have changed anything a recovery must check. */
const READS = new Set(['read_conversation', 'read_message', 'corpus_search']);

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

/** Whether a structured error says the network was unavailable. #467 can add Kiro’s code without message matching. */
export function isNetworkFailure(error) {
  for (let e = error, depth = 0; e && depth < 10; e = e.cause, depth++) if (e.kind === 'unreachable' || NETWORK_CODES.has(e.code)) return true;
  return false;
}

/** The bounded delay before retry number attempt. */
const retryDelay = (attempt) => Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(Math.max(0, attempt - 1), 9));
const recoveryText = (turn, tools, why = 'failed because the network dropped') =>
  `[Postbox] Your last scheduled turn${turn ? ` (${turn.id})` : ''} ${why} after it started ${tools.join(', ')}. Check what those calls changed or sent before you continue. Do not repeat them until you have checked their effects.`;

/** Settles a scheduled wake’s turn, re-arming only the current schedule after a network failure. */
export function settleScheduledWake(rt, turn, err) {
  const id = turn.asked?.message?.scheduledWakeId;
  if (!id) return;
  const sc = rt.s.schedules[id];
  if (!sc) return;
  if (!err || err.name === 'AbortError') return finishSchedule(rt, sc, err ? 'canceled' : 'done');
  // A host turn marked lost is still running there and RemoteTurns will attach it again; no second recovery is armed.
  if (rt.s.sessions[turn.sessionId]?.remoteTurn?.state === 'lost') return finishSchedule(rt, sc, 'done');
  if (!isNetworkFailure(err)) return finishSchedule(rt, sc, 'done');
  const now = Date.now();
  const attempt = (sc.attempt ?? 0) + 1;
  const firstFailureAt = sc.firstFailureAt ?? now;
  if (now - firstFailureAt >= RETRY_WINDOW_MS) {
    finishSchedule(rt, sc, 'stopped', { retryAttempt: attempt, retryStopped: true });
    return;
  }
  const tools = [...new Set([...(sc.recoveryTools ?? []), ...(turn.scheduledTools ?? [])])].slice(0, TOOL_LIMIT);
  const next = {
    ...sc,
    running: false,
    turnId: undefined,
    at: now + retryDelay(attempt),
    attempt,
    firstFailureAt,
    ...(tools.length ? { recoveryTools: tools, recoveryNote: recoveryText(turn, tools) } : {}),
  };
  rt.store.emit('schedule', next);
  // The line keeps the recovery too, for a Retry after you cancel the schedule (prepareScheduledRetry).
  if (next.itemId)
    rt.patchItem(next.threadId, next.itemId, {
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
  if (sc.itemId) rt.patchItem(sc.threadId, sc.itemId, { status, retryAttempt: null, retryStopped: false, ...patch });
}

/** Cancels one pending or running schedule. @param {any} rt @param {string} scheduleId */
export function cancelWakeSchedule(rt, scheduleId) {
  const sc = rt.s.schedules[scheduleId];
  if (!sc) throw httpError(404, 'That wake-up already happened or was canceled.');
  finishSchedule(rt, sc, 'canceled');
}

/**
 * The wake’s own turn, saved on its schedule as the turn goes to a host, so a restart can tell it from another turn
 * there (rearmWakes). @param {any} rt @param {any} turn
 */
export function noteScheduledTurn(rt, turn) {
  const id = turn?.asked?.message?.scheduledWakeId;
  const sc = typeof id === 'string' ? rt.s.schedules[id] : null;
  if (sc && sc.turnId !== turn.id) rt.store.emit('schedule', { ...sc, turnId: turn.id });
}

/** Whether a running schedule’s own turn is still on its host, in any state RemoteTurns attaches again. */
const onHost = (rt, sc) => {
  const r = rt.s.sessions[sc.sessionId]?.remoteTurn;
  return typeof sc.turnId === 'string' && ON_HOST.has(r?.state) && r.rtTurn === sc.turnId;
};

/**
 * Re-arms schedules after restart. One interrupted while running becomes due again, as a recovery if a tool had started,
 * so its instruction isn’t replayed. One whose own turn is still on a host is that turn’s: RemoteTurns attaches it
 * again. One queued behind another turn there never started its own, so it’s due again too.
 */
export function rearmWakes(rt) {
  for (const sc of Object.values(rt.s.schedules)) {
    if (sc.running && onHost(rt, sc)) {
      finishSchedule(rt, sc, 'done');
      continue;
    }
    const tools = [...new Set([...(sc.recoveryTools ?? []), ...(sc.startedTools ?? [])])].slice(0, TOOL_LIMIT);
    const interrupted = tools.length ? { recoveryTools: tools, recoveryNote: recoveryText(null, tools, 'was interrupted when Postbox stopped') } : {};
    const pending = sc.running ? { ...sc, running: false, at: Date.now(), startedTools: undefined, turnId: undefined, ...interrupted } : sc;
    if (pending !== sc) rt.store.emit('schedule', pending);
    armWake(rt, pending);
  }
}

/** A scheduled wake waiting behind a turn you stopped goes with it (#466): it’s settled, not left running. */
export function dropScheduledWake(rt, message) {
  const sc = typeof message?.scheduledWakeId === 'string' ? rt.s.schedules[message.scheduledWakeId] : null;
  if (sc) finishSchedule(rt, sc, 'canceled');
}
