// A Claude Code turn waiting on a background task (#847): once the model has sent its result, Claude Code keeps its
// process alive until the task ends, and prints nothing meanwhile (tool_progress comes only for a foreground call).
// Its stream lists the open tasks in each `system` event of the adapter’s capabilities.remote.backgroundTasks
// subtype (background_tasks_changed). While one is listed the turn isn’t quiet, up to QUIET.backgroundMax from when
// the list last became non-empty; past that it’s stopped as hung, naming the task.

import { QUIET } from '../../shared/limits.mjs';

/** How much of a task’s description the stop text quotes: the agent wrote it. */
const NAME_CHARS = 80;
// Control characters, and the bidi and zero-width ones that would change how the note reads.
const UNPRINTABLE = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Takes in a stdout line that may list the open background tasks. Only a parsed `system` event of that subtype with a
 * `tasks` array counts, so the same words in an assistant’s text don’t. O(line length) for any other line.
 * @param {import('./turns-shared.mjs').Live} live @param {string} text @param {number} now
 */
export function noteBackground(live, text, now) {
  const subtype = live.backgroundTasks;
  if (!subtype || !text.includes(subtype)) return;
  let e;
  try {
    e = JSON.parse(text);
  } catch {
    return;
  }
  if (e?.type !== 'system' || e.subtype !== subtype || !Array.isArray(e.tasks)) return;
  if (!e.tasks.length) {
    live.background = null;
    return;
  }
  const names = e.tasks.map((/** @type {any} */ t) => String(t?.description ?? t?.task_id ?? ''));
  live.background = { since: live.background?.since ?? now, names };
}

/** Whether a quiet turn is waiting on a listed background task, within the ceiling. @param {import('./turns-shared.mjs').Live} live @param {number} now */
export function waitingOnBackground(live, now) {
  const open = live.background;
  return open !== null && now - open.since < QUIET.backgroundMax;
}

/** The stop text for a turn whose background task ran past the ceiling, or null if none is listed. @param {import('./turns-shared.mjs').Live} live */
export function backgroundStopText(live) {
  if (!live.background) return null;
  const name = live.background.names[0].replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  const clipped = name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name;
  const hours = QUIET.backgroundMax / 3_600_000;
  return `Stopped: a background task (${clipped || 'unnamed'}) ran past ${hours} h with no output`;
}
