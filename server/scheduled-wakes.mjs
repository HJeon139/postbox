// Scheduled wake lifecycle: its persisted record, timer, transcript line, cancellation and restart re-arming (#458).

import { httpError } from './helpers.mjs';
import { newId } from './store.mjs';

/** Creates and arms one scheduled wake. @param {any} rt @param {string} sessionId @param {{ inMs: number, note?: string }} options */
export function scheduleWake(rt, sessionId, { inMs, note }) {
  const se = rt.session(sessionId);
  const at = Date.now() + Math.max(1000, Math.min(inMs, 7 * 24 * 3600 * 1000));
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
  rt.timers.set(
    sc.id,
    setTimeout(
      () => {
        rt.timers.delete(sc.id);
        if (!rt.s.schedules[sc.id]) return;
        rt.store.emit('schedule', { id: sc.id, removed: true });
        if (sc.itemId) rt.patchItem(sc.threadId, sc.itemId, { status: 'done' });
        // An archived agent isn’t woken: deliver() would refuse it, here outside any request (#101).
        if (!rt.s.sessions[sc.sessionId] || rt.s.sessions[sc.sessionId].archived) return;
        rt.addItem(sc.threadId, { kind: 'system', variant: 'wake', from: sc.handle, to: sc.handle, scheduled: true });
        rt.deliver(sc.sessionId, { kind: 'wake', note: sc.note });
      },
      Math.max(0, sc.at - Date.now()),
    ).unref(),
  );
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
