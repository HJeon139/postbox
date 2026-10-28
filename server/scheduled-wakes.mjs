// Scheduled wake lifecycle: persistence, timers, cancellation, restart re-arming and network recovery (#458, #466).

import { httpError } from './helpers.mjs';
import { newId } from './store.mjs';

const DAY = 24 * 3600 * 1000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_WINDOW_MS = 60 * 60_000;
const NETWORK_CODES = new Set(['EADDRNOTAVAIL', 'ENOTFOUND', 'ECONNRESET']);

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

/** Arms one persisted schedule. @param {any} rt @param {any} sc */
export function armWake(rt, sc) {
  clearTimeout(rt.timers.get(sc.id));
  rt.timers.set(sc.id, setTimeout(() => fireScheduledWake(rt, sc), Math.max(0, sc.at - Date.now())).unref());
}

/** Fires one due wake. Exported so deterministic tests don’t wait for real time. @param {any} rt @param {any} sc */
export function fireScheduledWake(rt, sc) {
  rt.timers.delete(sc.id);
  if (!rt.s.schedules[sc.id]) return;
  rt.store.emit('schedule', { id: sc.id, removed: true });
  if (sc.itemId) rt.patchItem(sc.threadId, sc.itemId, { status: 'done' });
  // An archived agent isn’t woken: deliver() would refuse it, here outside any request (#101).
  if (!rt.s.sessions[sc.sessionId] || rt.s.sessions[sc.sessionId].archived) return;
  if (!sc.attempt) rt.addItem(sc.threadId, { kind: 'system', variant: 'wake', from: sc.handle, to: sc.handle, scheduled: true });
  rt.deliver(sc.sessionId, { kind: 'wake', note: sc.recoveryNote ?? sc.note, scheduledWake: sc });
}

/** Records a tool start, including what scheduled-wake recovery will need. @param {any} rt @param {any} turn @param {any} call */
export function recordScheduledTool(rt, turn, call) {
  rt.ledger.toolUse(turn, call);
  if (!turn.asked?.message?.scheduledWake || typeof call?.name !== 'string') return;
  turn.scheduledTools ??= [];
  if (!turn.scheduledTools.includes(call.name)) turn.scheduledTools.push(call.name.slice(0, 100));
}

/** Whether a structured error says the network was unavailable. #467 can add Kiro’s code without message matching. */
export function isNetworkFailure(error) {
  for (let e = error; e; e = e.cause) if (e.kind === 'unreachable' || NETWORK_CODES.has(e.code)) return true;
  return false;
}

/** The bounded delay before retry number attempt. */
const retryDelay = (attempt) => Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(Math.max(0, attempt - 1), 6));
const recoveryText = (turn, tools) =>
  `[Postbox] Your last scheduled turn (${turn.id}) failed because the network dropped after it started ${tools.join(', ')}. Check what those calls changed or sent before you continue. Do not repeat them until you have checked their effects.`;

/** Re-arms a scheduled wake after a network failure. @param {any} rt @param {any} turn @param {any} err */
export function settleScheduledWake(rt, turn, err) {
  const sc = turn.asked?.message?.scheduledWake;
  if (!sc || !err || err.name === 'AbortError' || !isNetworkFailure(err)) return;
  const now = Date.now();
  const attempt = (sc.attempt ?? 0) + 1;
  const firstFailureAt = sc.firstFailureAt ?? now;
  if (now - firstFailureAt >= RETRY_WINDOW_MS) {
    if (sc.itemId) rt.patchItem(sc.threadId, sc.itemId, { status: 'pending', retryAttempt: attempt, retryStopped: true });
    return;
  }
  const tools = [...new Set([...(sc.recoveryTools ?? []), ...(turn.scheduledTools ?? [])])];
  const next = {
    ...sc,
    at: now + retryDelay(attempt),
    attempt,
    firstFailureAt,
    ...(tools.length ? { recoveryTools: tools, recoveryNote: recoveryText(turn, tools) } : {}),
  };
  rt.store.emit('schedule', next);
  if (next.itemId) rt.patchItem(next.threadId, next.itemId, { status: 'pending', at: next.at, retryAttempt: attempt, retryStopped: false });
  armWake(rt, next);
}

/** Cancels one pending schedule. @param {any} rt @param {string} scheduleId */
export function cancelWakeSchedule(rt, scheduleId) {
  const sc = rt.s.schedules[scheduleId];
  if (!sc) throw httpError(404, 'That wake-up already happened or was canceled.');
  clearTimeout(rt.timers.get(scheduleId));
  rt.timers.delete(scheduleId);
  rt.store.emit('schedule', { id: scheduleId, removed: true });
  if (sc.itemId) rt.patchItem(sc.threadId, sc.itemId, { status: 'canceled' });
}

/** Re-arms schedules after restart. @param {any} rt */
export function rearmWakes(rt) {
  for (const sc of Object.values(rt.s.schedules)) armWake(rt, sc);
}
