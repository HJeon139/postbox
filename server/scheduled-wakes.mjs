// Scheduled wake lifecycle: persistence, timers, cancellation, restart re-arming and network recovery (#458, #466).

import { httpError } from './helpers.mjs';
import { newId } from './store.mjs';

const DAY = 24 * 3600 * 1000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_WINDOW_MS = 60 * 60_000;
const NETWORK_CODES = new Set(['EADDRNOTAVAIL', 'ENOTFOUND', 'ECONNRESET']);
const TOOL_LIMIT = 20;
const TOOL_NAME_CHARS = 100;

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

/** Arms one current, pending schedule. @param {any} rt @param {any} sc */
export function armWake(rt, sc) {
  const current = rt.s.schedules[sc.id];
  if (!current || current.running) return;
  clearTimeout(rt.timers.get(sc.id));
  rt.timers.set(sc.id, setTimeout(() => fireScheduledWake(rt, sc.id), Math.max(0, current.at - Date.now())).unref());
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

/** A manual Retry takes ownership from the armed timer and uses the schedule’s current recovery note. */
export function prepareScheduledRetry(rt, message) {
  if (message?.retry !== true || typeof message.scheduledWakeId !== 'string') return message;
  const sc = rt.s.schedules[message.scheduledWakeId];
  if (!sc) return message;
  clearTimeout(rt.timers.get(sc.id));
  rt.timers.delete(sc.id);
  rt.store.emit('schedule', { ...sc, running: true });
  if (sc.itemId) rt.patchItem(sc.threadId, sc.itemId, { status: 'running' });
  return { ...message, note: sc.recoveryNote ?? sc.note };
}

const addTool = (turn, name) => {
  if (!turn.asked?.message?.scheduledWakeId || typeof name !== 'string') return;
  const clipped = name.slice(0, TOOL_NAME_CHARS);
  turn.scheduledTools ??= [];
  if (!turn.scheduledTools.includes(clipped) && turn.scheduledTools.length < TOOL_LIMIT) turn.scheduledTools.push(clipped);
};

/** Records a Claude or mock tool start, including what scheduled-wake recovery will need. */
export function recordScheduledTool(rt, turn, call, ledger = true) {
  if (ledger) rt.ledger.toolUse(turn, call);
  addTool(turn, call?.name);
}

/** Whether a structured error says the network was unavailable. #467 can add Kiro’s code without message matching. */
export function isNetworkFailure(error) {
  for (let e = error, depth = 0; e && depth < 10; e = e.cause, depth++) if (e.kind === 'unreachable' || NETWORK_CODES.has(e.code)) return true;
  return false;
}

/** The bounded delay before retry number attempt. */
const retryDelay = (attempt) => Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(Math.max(0, attempt - 1), 9));
const recoveryText = (turn, tools) =>
  `[Postbox] Your last scheduled turn (${turn.id}) failed because the network dropped after it started ${tools.join(', ')}. Check what those calls changed or sent before you continue. Do not repeat them until you have checked their effects.`;

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
    at: now + retryDelay(attempt),
    attempt,
    firstFailureAt,
    ...(tools.length ? { recoveryTools: tools, recoveryNote: recoveryText(turn, tools) } : {}),
  };
  rt.store.emit('schedule', next);
  if (next.itemId) rt.patchItem(next.threadId, next.itemId, { status: 'pending', at: next.at, retryAttempt: attempt, retryStopped: false });
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

/** Re-arms schedules after restart; one interrupted while running becomes due again. */
export function rearmWakes(rt) {
  for (const sc of Object.values(rt.s.schedules)) {
    const pending = sc.running ? { ...sc, running: false, at: Date.now() } : sc;
    if (pending !== sc) rt.store.emit('schedule', pending);
    armWake(rt, pending);
  }
}
