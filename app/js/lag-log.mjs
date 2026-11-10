// The page’s lag log (#821, slice a): each key or click that took 500 ms or more to answer, as the browser’s Event
// Timing measured it, from its input to the next frame drawn. Off the input path: entries arrive in the observer’s
// callback, after the frame they describe, and Postbox’s own handlers change in nothing. A record holds only Postbox’s
// values, never the room’s text. It stays in this page, bounded; sending it to the server is #821’s next slice.

/** A key or click this slow, or slower, is a lag event (#821). */
const SLOW_MS = 500;
/** The records kept, newest last. */
const KEEP = 50;
/** The interactions Event Timing reports for a key or a click. */
const TYPES = new Set(['keydown', 'keypress', 'pointerdown', 'pointerup', 'click']);

/** @typedef {{ kind: 'interaction', type: string, at: number, duration: number, inputDelay: number, processing: number, presentation: number, role: string }} LagRecord */
/** @type {LagRecord[]} */
export const lagLog = [];
let started = false;
/** Whether the log is observing. */
export const lagLogStarted = () => started;

/** Where an interaction happened, by role, never by its text. @param {any} target */
function roleOf(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return 'other';
  if (el.closest('#composer-input, #side-input')) return 'composer';
  if (el.closest('iframe')) return 'app';
  if (el.closest('[data-block-item]')) return 'block';
  if (el.closest('.rail')) return 'rail';
  return 'other';
}

/** One interaction counts once, by its id, kept bounded. */
const counted = new Set();

/** @param {any} e a PerformanceEventTiming */
function record(e) {
  if (e.duration < SLOW_MS || !TYPES.has(e.name) || document.visibilityState === 'hidden') return;
  const key = e.interactionId || `${e.name}@${e.startTime}`;
  if (counted.has(key)) return;
  if (counted.size >= KEEP * 4) counted.clear();
  counted.add(key);
  const inputDelay = Math.max(0, e.processingStart - e.startTime);
  const processing = Math.max(0, e.processingEnd - e.processingStart);
  lagLog.push({
    kind: 'interaction',
    type: e.name,
    at: Math.round(performance.timeOrigin + e.startTime),
    duration: Math.round(e.duration),
    inputDelay: Math.round(inputDelay),
    processing: Math.round(processing),
    presentation: Math.max(0, Math.round(e.duration - inputDelay - processing)),
    role: roleOf(e.target),
  });
  if (lagLog.length > KEEP) lagLog.shift();
}

/**
 * Starts observing, once, where the browser has Event Timing. An error in the observer turns the log off for the
 * session, and never reaches the page. Returns whether it observes.
 */
export function startLagLog() {
  if (started) return true;
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('event')) return false;
  /** @type {PerformanceObserver | null} */
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      try {
        for (const e of list.getEntries()) record(e);
      } catch (err) {
        observer?.disconnect();
        started = false;
        console.warn(`Postbox’s lag log stopped: ${/** @type {Error} */ (err).message}`);
      }
    });
    // The lowest threshold the browser takes, as PF-1’s bench uses (#777); the log keeps only 500 ms or more.
    observer.observe(/** @type {any} */ ({ type: 'event', durationThreshold: 16 }));
  } catch {
    return false;
  }
  started = true;
  return true;
}
